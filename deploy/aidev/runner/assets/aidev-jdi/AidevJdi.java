// aidev-jdi — a Debug Adapter Protocol server for the JVM (Java, Kotlin, Scala, Groovy …) built only on the
// JDK's own debugger interface (JDI, module jdk.jdi). No dependencies: one class file set in one jar that the
// runner ships inside its own binary (runner/src/dap_adapters.rs, adapter "jvm"). It speaks DAP over stdio.
//
//   launch {mainClass | jar, classPath[], modulePath[], args[], vmArgs[], cwd, env{}, javaExec, stopOnEntry, sourcePaths[]}
//          starts `java -agentlib:jdwp=…,suspend=y` itself (the program waits until configurationDone)
//   attach {hostName, port, sourcePaths[], cwd}   any JVM started with -agentlib:jdwp=transport=dt_socket,server=y
//          (Android apps through `adb forward tcp:N jdwp:<pid>` included)
//
// Breakpoints are matched by source file name and package path (ClassPrepareRequest with a source-name
// filter), so they work for any build layout, nested/anonymous classes, lambdas and Kotlin file classes.
// Evaluate understands locals, fields, statics, array indexing, arithmetic/comparison/logic, string
// concatenation and method calls. Build: ./build.sh (javac --release 11; runs on any JDK ≥ 11, debugs JVMs ≥ 8).
import com.sun.jdi.*;
import com.sun.jdi.connect.AttachingConnector;
import com.sun.jdi.connect.Connector;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;

import java.io.*;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

public final class AidevJdi {
    static final String VERSION = "1.0.0";
    static final String[] STEP_EXCLUDES = { "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*", "kotlinx.*", "scala.*", "groovy.*", "org.codehaus.groovy.*" };

    // ------------------------------------------------------------------ JSON
    static final class Json {
        final String s; int i;
        Json(String s) { this.s = s; }
        static Object parse(String s) { Json j = new Json(s); j.ws(); Object v = j.value(); return v; }
        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                i++; Map<String, Object> m = new LinkedHashMap<>(); ws();
                if (s.charAt(i) == '}') { i++; return m; }
                for (;;) { ws(); String k = str(); ws(); i++; m.put(k, value()); ws(); char d = s.charAt(i++); if (d == '}') return m; }
            }
            if (c == '[') {
                i++; List<Object> l = new ArrayList<>(); ws();
                if (s.charAt(i) == ']') { i++; return l; }
                for (;;) { l.add(value()); ws(); char d = s.charAt(i++); if (d == ']') return l; }
            }
            if (c == '"') return str();
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int st = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(st, i);
            if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
            return Long.parseLong(n);
        }
        String str() {
            StringBuilder b = new StringBuilder(); i++;
            for (;;) {
                char c = s.charAt(i++);
                if (c == '"') return b.toString();
                if (c != '\\') { b.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n': b.append('\n'); break; case 't': b.append('\t'); break; case 'r': b.append('\r'); break;
                    case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                    case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                    default: b.append(e);
                }
            }
        }
        static String write(Object o) { StringBuilder b = new StringBuilder(); write(b, o); return b.toString(); }
        @SuppressWarnings("unchecked")
        static void write(StringBuilder b, Object o) {
            if (o == null) b.append("null");
            else if (o instanceof String) quote(b, (String) o);
            else if (o instanceof Boolean || o instanceof Integer || o instanceof Long) b.append(o);
            else if (o instanceof Number) { double d = ((Number) o).doubleValue(); b.append(d == Math.rint(d) && Math.abs(d) < 1e15 ? String.valueOf((long) d) : String.valueOf(d)); }
            else if (o instanceof Map) {
                b.append('{'); boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (e.getValue() == null) continue;
                    if (!first) b.append(','); first = false; quote(b, e.getKey()); b.append(':'); write(b, e.getValue());
                }
                b.append('}');
            } else if (o instanceof Collection) {
                b.append('['); boolean first = true;
                for (Object x : (Collection<Object>) o) { if (!first) b.append(','); first = false; write(b, x); }
                b.append(']');
            } else quote(b, String.valueOf(o));
        }
        static void quote(StringBuilder b, String s) {
            b.append('"');
            for (int k = 0; k < s.length(); k++) {
                char c = s.charAt(k);
                switch (c) {
                    case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break;
                    case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break;
                    default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c);
                }
            }
            b.append('"');
        }
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int k = 0; k + 1 < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]);
        return m;
    }
    @SuppressWarnings("unchecked") static Map<String, Object> obj(Object o) { return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>(); }
    static String str(Map<String, Object> m, String k) { Object v = m.get(k); return v == null ? null : String.valueOf(v); }
    static long num(Map<String, Object> m, String k, long d) { Object v = m.get(k); return v instanceof Number ? ((Number) v).longValue() : d; }
    static boolean bool(Map<String, Object> m, String k) { return Boolean.TRUE.equals(m.get(k)); }
    static List<String> strs(Object v) {
        List<String> l = new ArrayList<>();
        if (v instanceof List) for (Object x : (List<?>) v) { if (x != null) l.add(String.valueOf(x)); }
        else if (v instanceof String && !((String) v).isEmpty()) l.add((String) v);
        return l;
    }

    // ------------------------------------------------------------------ protocol
    static final OutputStream OUT = new BufferedOutputStream(new FileOutputStream(FileDescriptor.out));
    static int seq = 1;

    static synchronized void send(Map<String, Object> msg) {
        msg.put("seq", seq++);
        byte[] body = Json.write(msg).getBytes(StandardCharsets.UTF_8);
        try {
            OUT.write(("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
            OUT.write(body);
            OUT.flush();
        } catch (IOException e) { System.exit(0); }
    }
    static void event(String name, Map<String, Object> body) { send(map("type", "event", "event", name, "body", body)); }
    static void output(String category, String text) { event("output", map("category", category, "output", text)); }

    static final class DapError extends Exception { private static final long serialVersionUID = 1L; DapError(String m) { super(m); } }

    static String readMessage(InputStream in) throws IOException {
        int len = -1;
        StringBuilder line = new StringBuilder();
        for (;;) {
            int c = in.read();
            if (c < 0) return null;
            if (c == '\n') {
                String l = line.toString().trim(); line.setLength(0);
                if (l.isEmpty()) { if (len >= 0) break; continue; }
                if (l.toLowerCase(Locale.ROOT).startsWith("content-length:")) len = Integer.parseInt(l.substring(15).trim());
            } else line.append((char) c);
        }
        byte[] buf = in.readNBytes(len);
        if (buf.length < len) return null;
        return new String(buf, StandardCharsets.UTF_8);
    }

    public static void main(String[] argv) throws Exception {
        System.setOut(System.err); // stdout is the protocol
        if (argv.length > 0 && argv[0].equals("--version")) { System.err.println("aidev-jdi " + VERSION); return; }
        AidevJdi a = new AidevJdi();
        InputStream in = new BufferedInputStream(new FileInputStream(FileDescriptor.in));
        for (;;) {
            String text = readMessage(in);
            if (text == null) { a.shutdown(); return; }
            Map<String, Object> req;
            try { req = obj(Json.parse(text)); } catch (RuntimeException e) { continue; }
            if (!"request".equals(req.get("type"))) continue;
            String command = str(req, "command");
            Map<String, Object> resp = map("type", "response", "request_seq", req.get("seq"), "command", command);
            try {
                Object body = a.handle(command, obj(req.get("arguments")));
                resp.put("success", true);
                if (body != null) resp.put("body", body);
            } catch (DapError | VMDisconnectedException | IllegalArgumentException | IllegalStateException e) {
                resp.put("success", false);
                resp.put("message", e instanceof VMDisconnectedException ? "디버그 대상과의 연결이 끊겼습니다" : String.valueOf(e.getMessage()));
            } catch (Exception e) {
                resp.put("success", false);
                resp.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            send(resp);
            if ("initialize".equals(command) && Boolean.TRUE.equals(resp.get("success"))) event("initialized", map());
            if ("disconnect".equals(command) || "terminate".equals(command) && a.vm == null) { OUT.flush(); a.shutdown(); return; }
        }
    }

    // ------------------------------------------------------------------ session state
    final Object lock = new Object();
    volatile VirtualMachine vm;
    Process process;
    boolean launched, configured, terminatedSent, stopOnEntry;
    String mainClass;
    EventSet heldStart;               // VMStart held until configurationDone
    Path cwd = Paths.get("").toAbsolutePath();
    final List<Path> sourceRoots = new ArrayList<>();
    final Map<String, Path> sourceByKey = new ConcurrentHashMap<>();   // "com/x/Main.java" → file
    List<Path> walked;                                                 // files under cwd, for source lookup

    static final class Bp {
        final int id; final int line; final String condition; final List<BreakpointRequest> requests = new ArrayList<>();
        boolean verified; String message;
        Bp(int id, int line, String condition) { this.id = id; this.line = line; this.condition = condition; }
    }
    static final class FileBps {
        final Path path; final List<Bp> bps = new ArrayList<>(); ClassPrepareRequest prepare; String pkg;
        FileBps(Path p) { path = p; }
        String pkg() { if (pkg == null) pkg = packageOf(path); return pkg; }
    }
    final Map<String, FileBps> files = new LinkedHashMap<>();          // normalized path → breakpoints
    int bpIds = 1;
    ExceptionRequest exceptionRequest;
    boolean caught, uncaught;

    // stopped state (cleared on resume)
    ThreadReference stoppedThread;
    final Map<Integer, Object[]> frames = new HashMap<>();             // frameId → {thread, index}
    final Map<Integer, Object> refs = new HashMap<>();                 // variablesReference → FrameScope | ObjectReference
    int nextRef = 1;
    volatile ThreadReference invoking;                                 // thread running an evaluate method call
    static final class FrameScope { final ThreadReference t; final int index; FrameScope(ThreadReference t, int i) { this.t = t; index = i; } }

    Object handle(String command, Map<String, Object> a) throws Exception {
        switch (command) {
            case "initialize": return capabilities();
            case "launch": launch(a); return null;
            case "attach": attach(a); return null;
            case "setBreakpoints": return setBreakpoints(a);
            case "setExceptionBreakpoints": return setExceptionBreakpoints(a);
            case "setFunctionBreakpoints": return map("breakpoints", new ArrayList<>());
            case "configurationDone": configurationDone(); return null;
            case "threads": return threads();
            case "stackTrace": return stackTrace(a);
            case "scopes": return scopes(a);
            case "variables": return variables(a);
            case "setVariable": return setVariable(a);
            case "evaluate": return evaluate(a);
            case "continue": resume(); return map("allThreadsContinued", true);
            case "next": step(a, StepRequest.STEP_OVER); return null;
            case "stepIn": step(a, StepRequest.STEP_INTO); return null;
            case "stepOut": step(a, StepRequest.STEP_OUT); return null;
            case "pause": pause(); return null;
            case "exceptionInfo": return exceptionInfo(a);
            case "source": throw new DapError("소스 내용은 제공하지 않습니다");
            case "terminate": case "disconnect": disconnect(a, command.equals("terminate")); return null;
            default: throw new DapError(command + " 요청은 지원하지 않습니다");
        }
    }

    Map<String, Object> capabilities() {
        return map(
            "supportsConfigurationDoneRequest", true,
            "supportsConditionalBreakpoints", true,
            "supportsEvaluateForHovers", true,
            "supportsSetVariable", true,
            "supportsTerminateRequest", true,
            "supportsExceptionInfoRequest", true,
            "exceptionBreakpointFilters", List.of(
                map("filter", "uncaught", "label", "처리되지 않은 예외", "default", true),
                map("filter", "caught", "label", "모든 예외", "default", false)));
    }

    // ------------------------------------------------------------------ launch / attach
    void roots(Map<String, Object> a) {
        String c = str(a, "cwd");
        if (c != null && !c.isEmpty()) cwd = Paths.get(c).toAbsolutePath().normalize();
        for (String s : strs(a.get("sourcePaths"))) sourceRoots.add(cwd.resolve(s).normalize());
        for (String s : new String[] { "", "src/main/java", "src/main/kotlin", "src/test/java", "src/test/kotlin", "src", "app/src/main/java", "app/src/main/kotlin", "src/main/scala" }) {
            Path p = cwd.resolve(s).normalize();
            if (Files.isDirectory(p) && !sourceRoots.contains(p)) sourceRoots.add(p);
        }
    }

    void launch(Map<String, Object> a) throws Exception {
        roots(a);
        stopOnEntry = bool(a, "stopOnEntry");
        mainClass = str(a, "mainClass");
        String jar = str(a, "jar");
        if ((mainClass == null || mainClass.isEmpty()) && (jar == null || jar.isEmpty())) throw new DapError("launch: mainClass 또는 jar가 필요합니다");
        String java = str(a, "javaExec");
        if (java == null || java.isEmpty()) {
            String home = str(a, "javaHome");
            java = home != null && !home.isEmpty() ? Paths.get(home, "bin", isWindows() ? "java.exe" : "java").toString() : "java";
        }
        int port;
        try (ServerSocket ss = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = ss.getLocalPort(); }
        List<String> cmd = new ArrayList<>();
        cmd.add(java);
        cmd.add("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:" + port);
        cmd.addAll(strs(a.get("vmArgs")));
        List<String> cp = strs(a.get("classPath"));
        if (!cp.isEmpty()) { cmd.add("-cp"); cmd.add(String.join(File.pathSeparator, cp)); }
        List<String> mp = strs(a.get("modulePath"));
        if (!mp.isEmpty()) { cmd.add("--module-path"); cmd.add(String.join(File.pathSeparator, mp)); }
        if (jar != null && !jar.isEmpty()) { cmd.add("-jar"); cmd.add(jar); }
        else if (mainClass.contains("/")) { cmd.add("-m"); cmd.add(mainClass); mainClass = mainClass.substring(mainClass.indexOf('/') + 1); }
        else cmd.add(mainClass);
        cmd.addAll(strs(a.get("args")));
        ProcessBuilder pb = new ProcessBuilder(cmd).directory(cwd.toFile());
        for (Map.Entry<String, Object> e : obj(a.get("env")).entrySet()) if (e.getValue() != null) pb.environment().put(e.getKey(), String.valueOf(e.getValue()));
        try { process = pb.start(); } catch (IOException e) { throw new DapError(java + "을(를) 실행하지 못했습니다: " + e.getMessage()); }
        launched = true;
        pump(process.getInputStream(), "stdout");
        pump(process.getErrorStream(), "stderr");
        process.getOutputStream().close();
        connect("127.0.0.1", port, 30_000);
    }

    void attach(Map<String, Object> a) throws Exception {
        roots(a);
        String host = str(a, "hostName");
        if (host == null || host.isEmpty()) host = "127.0.0.1";
        long port = num(a, "port", -1);
        if (port <= 0) throw new DapError("attach: port가 필요합니다");
        connect(host, (int) port, (int) num(a, "timeout", 15_000));
    }

    void connect(String host, int port, int timeoutMs) throws Exception {
        AttachingConnector conn = Bootstrap.virtualMachineManager().attachingConnectors().stream()
            .filter(c -> c.name().equals("com.sun.jdi.SocketAttach")).findFirst().orElseThrow(() -> new DapError("JDI SocketAttach 커넥터가 없습니다 (JDK가 필요합니다)"));
        Map<String, Connector.Argument> args = conn.defaultArguments();
        args.get("hostname").setValue(host);
        args.get("port").setValue(String.valueOf(port));
        if (args.containsKey("timeout")) args.get("timeout").setValue("5000");
        long deadline = System.currentTimeMillis() + timeoutMs;
        IOException last = null;
        while (System.currentTimeMillis() < deadline) {
            if (process != null && !process.isAlive()) throw new DapError("프로그램이 디버거 연결 전에 끝났습니다 (exit " + process.exitValue() + ")");
            try { vm = conn.attach(args); break; } catch (IOException e) { last = e; Thread.sleep(150); }
        }
        if (vm == null) throw new DapError(host + ":" + port + " 에 JDWP로 연결하지 못했습니다" + (last != null ? " — " + last.getMessage() : ""));
        Thread t = new Thread(this::eventLoop, "aidev-jdi-events");
        t.setDaemon(true);
        t.start();
        synchronized (lock) {
            for (FileBps f : files.values()) installFile(f);
            applyExceptions();
            if (stopOnEntry && mainClass != null) {
                ClassPrepareRequest r = vm.eventRequestManager().createClassPrepareRequest();
                r.addClassFilter(mainClass);
                r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                r.putProperty("entry", Boolean.TRUE);
                r.enable();
            }
        }
    }

    void pump(InputStream in, String category) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int n;
                while ((n = in.read(buf)) > 0) {
                    String s = new String(buf, 0, n, StandardCharsets.UTF_8);
                    if (s.startsWith("Listening for transport dt_socket")) { int nl = s.indexOf('\n'); if (nl < 0) continue; s = s.substring(nl + 1); if (s.isEmpty()) continue; }
                    output(category, s);
                }
            } catch (IOException ignored) { /* process ended */ }
        }, "aidev-jdi-" + category);
        t.setDaemon(true);
        t.start();
    }

    void configurationDone() {
        synchronized (lock) {
            configured = true;
            if (heldStart != null) { EventSet s = heldStart; heldStart = null; s.resume(); }
        }
    }

    static boolean isWindows() { return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win"); }

    void shutdown() {
        try { if (vm != null) { if (launched) vm.exit(0); else vm.dispose(); } } catch (Exception ignored) { /* gone */ }
        if (process != null) process.destroy();
        System.exit(0);
    }

    void disconnect(Map<String, Object> a, boolean terminate) {
        boolean kill = a.containsKey("terminateDebuggee") ? bool(a, "terminateDebuggee") : launched || terminate;
        VirtualMachine v = vm;
        if (v == null) return;
        try {
            if (kill) { v.exit(0); } else { clearRequests(v); v.resume(); v.dispose(); }
        } catch (VMDisconnectedException ignored) { /* already gone */ }
        if (kill && process != null) process.destroy();
    }

    void clearRequests(VirtualMachine v) {
        EventRequestManager m = v.eventRequestManager();
        m.deleteAllBreakpoints();
        m.deleteEventRequests(new ArrayList<>(m.classPrepareRequests()));
        m.deleteEventRequests(new ArrayList<>(m.stepRequests()));
        m.deleteEventRequests(new ArrayList<>(m.exceptionRequests()));
    }

    // ------------------------------------------------------------------ breakpoints
    static String norm(Path p) { return p.toAbsolutePath().normalize().toString().replace('\\', '/'); }
    static String norm(String p) { return p.replace('\\', '/'); }

    Object setBreakpoints(Map<String, Object> a) throws Exception {
        Map<String, Object> source = obj(a.get("source"));
        String sp = str(source, "path");
        if (sp == null || sp.isEmpty()) throw new DapError("setBreakpoints: source.path가 필요합니다");
        Path path = cwd.resolve(sp).toAbsolutePath().normalize();
        List<Map<String, Object>> list = new ArrayList<>();
        if (a.get("breakpoints") instanceof List) for (Object o : (List<?>) a.get("breakpoints")) list.add(obj(o));
        else for (String l : strs(a.get("lines"))) list.add(map("line", Long.parseLong(l)));
        List<Object> result = new ArrayList<>();
        synchronized (lock) {
            String key = norm(path);
            FileBps old = files.remove(key);
            if (old != null && vm != null) dropFile(old);
            FileBps f = new FileBps(path);
            for (Map<String, Object> b : list) {
                String cond = str(b, "condition");
                f.bps.add(new Bp(bpIds++, (int) num(b, "line", 0), cond == null || cond.isBlank() ? null : cond));
            }
            if (!f.bps.isEmpty()) {
                files.put(key, f);
                if (vm != null) installFile(f);
            }
            for (Bp b : f.bps) result.add(bpBody(b, f));
        }
        return map("breakpoints", result);
    }

    Map<String, Object> bpBody(Bp b, FileBps f) {
        return map("id", b.id, "verified", b.verified, "line", b.line, "message", b.verified ? null : (b.message != null ? b.message : vm == null ? "디버그 대상 연결 전" : "클래스가 아직 로드되지 않았습니다 (로드되면 설정됩니다)"),
            "source", map("path", f.path.toString(), "name", f.path.getFileName().toString()));
    }

    void dropFile(FileBps f) {
        EventRequestManager m = vm.eventRequestManager();
        for (Bp b : f.bps) { m.deleteEventRequests(b.requests); b.requests.clear(); }
        if (f.prepare != null) { m.deleteEventRequest(f.prepare); f.prepare = null; }
    }

    /** Watches for classes compiled from this file and sets its breakpoints in the ones already loaded. */
    void installFile(FileBps f) {
        String name = f.path.getFileName().toString();
        EventRequestManager m = vm.eventRequestManager();
        if (f.prepare == null) {
            ClassPrepareRequest r = m.createClassPrepareRequest();
            if (vm.canUseSourceNameFilters()) r.addSourceNameFilter(name);
            else { String pkg = packageOf(f.path); String simple = name.replaceFirst("\\.[^.]+$", ""); r.addClassFilter((pkg.isEmpty() ? "" : pkg + ".") + simple + "*"); }
            r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            r.putProperty("file", norm(f.path));
            r.enable();
            f.prepare = r;
        }
        for (ReferenceType t : vm.allClasses()) if (fromFile(t, f)) installOn(t, f, false);
    }

    boolean fromFile(ReferenceType t, FileBps f) {
        if (!t.isPrepared()) return false;
        try {
            if (!t.sourceName().equals(f.path.getFileName().toString())) return false;
            String p = norm(f.path);
            for (String sp : t.sourcePaths(null)) {
                String n = norm(sp);
                if (p.endsWith("/" + n) || p.equals(n)) { sourceByKey.put(n, f.path); return true; }
            }
            // Kotlin allows a package that differs from the folder: compare the declared package instead
            String tn = t.name(); int dot = tn.lastIndexOf('.');
            if (f.pkg().equals(dot < 0 ? "" : tn.substring(0, dot))) { for (String sp : t.sourcePaths(null)) sourceByKey.put(norm(sp), f.path); return true; }
            return false;
        } catch (AbsentInformationException e) { return false; }
    }

    void installOn(ReferenceType t, FileBps f, boolean notify) {
        EventRequestManager m = vm.eventRequestManager();
        for (Bp b : f.bps) {
            List<Location> locs;
            try { locs = t.locationsOfLine(b.line); } catch (AbsentInformationException e) { b.message = t.name() + ": 줄 정보가 없습니다 (-g로 컴파일하세요)"; continue; }
            Set<Method> seen = new HashSet<>();
            boolean added = false;
            for (Location l : locs) {
                if (!seen.add(l.method())) continue;
                boolean dup = b.requests.stream().anyMatch(r -> r.location().equals(l));
                if (dup) continue;
                BreakpointRequest r = m.createBreakpointRequest(l);
                r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
                r.putProperty("bp", b);
                r.enable();
                b.requests.add(r);
                added = true;
            }
            if (added && !b.verified) {
                b.verified = true; b.message = null;
                if (notify) event("breakpoint", map("reason", "changed", "breakpoint", bpBody(b, f)));
            }
        }
    }

    static String packageOf(Path file) {
        try (Stream<String> lines = Files.lines(file)) {
            return lines.limit(200).map(String::trim).filter(l -> l.startsWith("package ")).findFirst()
                .map(l -> l.substring(8).replace(";", "").trim().replace("`", "")).orElse("");
        } catch (IOException | UncheckedIOException e) { return ""; }
    }

    Object setExceptionBreakpoints(Map<String, Object> a) {
        List<String> filters = strs(a.get("filters"));
        synchronized (lock) {
            caught = filters.contains("caught");
            uncaught = caught || filters.contains("uncaught");
            if (vm != null) applyExceptions();
        }
        return map("breakpoints", new ArrayList<>());
    }

    void applyExceptions() {
        EventRequestManager m = vm.eventRequestManager();
        if (exceptionRequest != null) { m.deleteEventRequest(exceptionRequest); exceptionRequest = null; }
        if (!caught && !uncaught) return;
        exceptionRequest = m.createExceptionRequest(null, caught, uncaught);
        for (String x : new String[] { "java.lang.ClassLoader", "java.net.URLClassLoader", "jdk.internal.*", "sun.*" }) exceptionRequest.addClassExclusionFilter(x);
        exceptionRequest.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        exceptionRequest.enable();
    }

    // ------------------------------------------------------------------ events
    void eventLoop() {
        EventQueue q = vm.eventQueue();
        for (;;) {
            EventSet set;
            try { set = q.remove(); } catch (InterruptedException e) { return; } catch (VMDisconnectedException e) { terminated(); return; }
            boolean resume = true;
            try {
                for (Event e : set) {
                    if (e instanceof VMStartEvent) {
                        synchronized (lock) { if (!configured) { heldStart = set; resume = false; } }
                    } else if (e instanceof ClassPrepareEvent) {
                        ClassPrepareEvent c = (ClassPrepareEvent) e;
                        synchronized (lock) {
                            if (Boolean.TRUE.equals(c.request().getProperty("entry"))) entryBreakpoint(c.referenceType());
                            else {
                                FileBps f = files.get(String.valueOf(c.request().getProperty("file")));
                                if (f != null && fromFile(c.referenceType(), f)) installOn(c.referenceType(), f, true);
                            }
                        }
                    } else if (e instanceof BreakpointEvent) {
                        BreakpointEvent b = (BreakpointEvent) e;
                        if (b.thread().equals(invoking)) continue;
                        Object tag = b.request().getProperty("bp");
                        if (tag instanceof Bp && ((Bp) tag).condition != null && !conditionHolds((Bp) tag, b.thread())) continue;
                        String reason = Boolean.TRUE.equals(b.request().getProperty("entry")) ? "entry" : "breakpoint";
                        if (reason.equals("entry")) vm.eventRequestManager().deleteEventRequest(b.request());
                        stopped(b.thread(), reason, null, tag instanceof Bp ? ((Bp) tag).id : null);
                        resume = false;
                    } else if (e instanceof StepEvent) {
                        StepEvent st = (StepEvent) e;
                        vm.eventRequestManager().deleteEventRequest(st.request());
                        if (st.thread().equals(invoking)) continue;
                        stopped(st.thread(), "step", null, null);
                        resume = false;
                    } else if (e instanceof ExceptionEvent) {
                        ExceptionEvent x = (ExceptionEvent) e;
                        if (x.thread().equals(invoking)) continue;
                        stopped(x.thread(), "exception", exceptionText(x.exception()) + (x.catchLocation() == null ? " (처리되지 않음)" : ""), null, x.exception());
                        resume = false;
                    } else if (e instanceof VMDeathEvent || e instanceof VMDisconnectEvent) {
                        terminated();
                        if (e instanceof VMDisconnectEvent) return;
                    }
                }
            } catch (VMDisconnectedException e) { terminated(); return; } catch (RuntimeException e) { output("console", "[aidev-jdi] " + e + "\n"); }
            if (resume) { try { set.resume(); } catch (VMDisconnectedException e) { terminated(); return; } }
        }
    }

    ObjectReference lastException;

    boolean entryBreakpoint(ReferenceType t) {
        for (Method m : t.methodsByName("main")) {
            Location l = m.location();
            if (l == null || m.isAbstract() || m.isNative()) continue;
            BreakpointRequest r = vm.eventRequestManager().createBreakpointRequest(l);
            r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            r.putProperty("entry", Boolean.TRUE);
            r.enable();
            return true;
        }
        return false;
    }

    boolean conditionHolds(Bp b, ThreadReference t) {
        try {
            Object v = new Eval(this, t, 0, false).run(b.condition);
            v = Eval.local(v);
            return !(v instanceof Boolean) || (Boolean) v;
        } catch (Exception e) {
            output("console", "[aidev-jdi] 조건 '" + b.condition + "' 평가 실패: " + e.getMessage() + " — 멈춥니다\n");
            return true;
        }
    }

    String exceptionText(ObjectReference ex) {
        String type = ex.referenceType().name();
        String msg = null;
        try {
            Field f = ex.referenceType().fieldByName("detailMessage");
            for (ReferenceType t = ex.referenceType(); f == null && t instanceof ClassType; t = ((ClassType) t).superclass()) f = t.fieldByName("detailMessage");
            Value v = f != null ? ex.getValue(f) : null;
            if (v instanceof StringReference) msg = ((StringReference) v).value();
        } catch (RuntimeException ignored) { /* no message */ }
        return msg == null ? type : type + ": " + msg;
    }

    void stopped(ThreadReference t, String reason, String description, Integer bpId) { stopped(t, reason, description, bpId, null); }
    void stopped(ThreadReference t, String reason, String description, Integer bpId, ObjectReference exception) {
        synchronized (lock) { clearPools(); stoppedThread = t; lastException = exception; }
        Map<String, Object> body = map("reason", reason, "threadId", tid(t), "allThreadsStopped", true, "description", description, "text", description);
        if (bpId != null) body.put("hitBreakpointIds", List.of(bpId));
        event("stopped", body);
    }

    void terminated() {
        synchronized (lock) {
            if (terminatedSent) return;
            terminatedSent = true;
        }
        Integer code = null;
        if (process != null) {
            try { if (process.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) code = process.exitValue(); } catch (InterruptedException ignored) { /* no code */ }
        }
        if (code != null) event("exited", map("exitCode", code));
        event("terminated", map());
    }

    void clearPools() { frames.clear(); refs.clear(); nextRef = 1; stoppedThread = null; lastException = null; }

    static int tid(ThreadReference t) { return (int) t.uniqueID(); }

    ThreadReference thread(Map<String, Object> a) throws DapError {
        long id = num(a, "threadId", -1);
        if (stoppedThread != null && (id < 0 || tid(stoppedThread) == id)) return stoppedThread;
        for (ThreadReference t : vm.allThreads()) if (tid(t) == id) return t;
        if (stoppedThread != null) return stoppedThread;
        throw new DapError("스레드 " + id + "이(가) 없습니다");
    }

    void resume() throws DapError {
        need();
        synchronized (lock) { clearPools(); }
        vm.resume();
    }

    void need() throws DapError { if (vm == null) throw new DapError("디버그 대상에 연결되지 않았습니다"); }

    void step(Map<String, Object> a, int depth) throws DapError {
        need();
        ThreadReference t = thread(a);
        EventRequestManager m = vm.eventRequestManager();
        for (StepRequest r : new ArrayList<>(m.stepRequests())) if (r.thread().equals(t)) m.deleteEventRequest(r);
        StepRequest r = m.createStepRequest(t, StepRequest.STEP_LINE, depth);
        for (String x : STEP_EXCLUDES) r.addClassExclusionFilter(x);
        r.addCountFilter(1);
        r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
        r.enable();
        synchronized (lock) { clearPools(); }
        vm.resume();
    }

    void pause() throws DapError {
        need();
        vm.suspend();
        ThreadReference main = null;
        for (ThreadReference t : vm.allThreads()) { if (t.name().equals("main")) { main = t; break; } if (main == null) main = t; }
        if (main != null) stopped(main, "pause", null, null);
    }

    Object exceptionInfo(Map<String, Object> a) throws DapError {
        ObjectReference x = lastException;
        if (x == null) throw new DapError("멈춘 예외가 없습니다");
        return map("exceptionId", x.referenceType().name(), "description", exceptionText(x), "breakMode", "always");
    }

    Object threads() {
        List<Object> l = new ArrayList<>();
        if (vm != null) {
            try { for (ThreadReference t : vm.allThreads()) l.add(map("id", tid(t), "name", t.name())); } catch (VMDisconnectedException ignored) { /* ended */ }
        }
        return map("threads", l);
    }

    // ------------------------------------------------------------------ stack, scopes, variables
    int frameId(ThreadReference t, int index) {
        synchronized (refs) { int id = nextRef++; frames.put(id, new Object[] { t, index }); return id; }
    }
    int ref(Object o) {
        synchronized (refs) { int id = nextRef++; refs.put(id, o); return id; }
    }
    StackFrame frame(long frameId) throws DapError, IncompatibleThreadStateException {
        Object[] f;
        synchronized (refs) { f = frames.get((int) frameId); }
        if (f == null) throw new DapError("프레임 " + frameId + "이(가) 없습니다 (프로그램이 다시 실행됐습니다)");
        return ((ThreadReference) f[0]).frame((Integer) f[1]);
    }
    Object[] frameEntry(long frameId) throws DapError {
        synchronized (refs) { Object[] f = frames.get((int) frameId); if (f == null) throw new DapError("프레임 " + frameId + "이(가) 없습니다"); return f; }
    }

    Object stackTrace(Map<String, Object> a) throws Exception {
        need();
        ThreadReference t = thread(a);
        int start = (int) num(a, "startFrame", 0), levels = (int) num(a, "levels", 0);
        int total;
        List<StackFrame> fs;
        try {
            total = t.frameCount();
            int count = levels <= 0 ? total - start : Math.min(levels, total - start);
            fs = count <= 0 ? List.of() : t.frames(start, count);
        } catch (IncompatibleThreadStateException e) { throw new DapError("스레드가 멈춰 있지 않습니다"); }
        List<Object> out = new ArrayList<>();
        for (int k = 0; k < fs.size(); k++) {
            Location l = fs.get(k).location();
            Method m = l.method();
            String type = l.declaringType().name();
            String simple = type.substring(type.lastIndexOf('.') + 1);
            Map<String, Object> f = map("id", frameId(t, start + k), "name", simple + "." + m.name() + "(" + String.join(", ", shortNames(m)) + ")", "line", Math.max(l.lineNumber(), 0), "column", 1);
            Path src = sourceOf(l);
            String sourceName = null;
            try { sourceName = l.sourceName(); } catch (AbsentInformationException ignored) { /* no debug info */ }
            if (src != null) f.put("source", map("path", src.toString(), "name", src.getFileName().toString()));
            else {
                if (sourceName != null) f.put("source", map("name", sourceName, "presentationHint", "deemphasize"));
                f.put("presentationHint", "subtle");
            }
            out.add(f);
        }
        return map("stackFrames", out, "totalFrames", total);
    }

    static List<String> shortNames(Method m) {
        List<String> l = new ArrayList<>();
        for (String n : m.argumentTypeNames()) l.add(n.substring(n.lastIndexOf('.') + 1));
        return l;
    }

    Path sourceOf(Location l) {
        String key;
        try { key = norm(l.sourcePath()); } catch (AbsentInformationException e) { return null; }
        Path hit = sourceByKey.get(key);
        if (hit != null) return hit;
        for (Path root : sourceRoots) {
            Path p = root.resolve(key);
            if (Files.isRegularFile(p)) { sourceByKey.put(key, p); return p; }
        }
        String name = key.substring(key.lastIndexOf('/') + 1);
        for (Path p : walk()) {
            if (p.getFileName().toString().equals(name) && norm(p).endsWith("/" + key)) { sourceByKey.put(key, p); return p; }
        }
        return null;
    }

    synchronized List<Path> walk() {
        if (walked != null) return walked;
        walked = new ArrayList<>();
        try (Stream<Path> s = Files.walk(cwd, 12)) {
            s.filter(p -> {
                String n = norm(p);
                return !n.contains("/.git/") && !n.contains("/node_modules/") && !n.contains("/.gradle/") && Files.isRegularFile(p) && n.matches(".*\\.(java|kt|kts|scala|groovy)$");
            }).limit(50_000).forEach(walked::add);
        } catch (IOException | UncheckedIOException ignored) { /* partial */ }
        return walked;
    }

    Object scopes(Map<String, Object> a) throws Exception {
        need();
        long fid = num(a, "frameId", -1);
        Object[] f = frameEntry(fid);
        List<Object> l = new ArrayList<>();
        l.add(map("name", "Locals", "presentationHint", "locals", "variablesReference", ref(new FrameScope((ThreadReference) f[0], (Integer) f[1])), "expensive", false));
        StackFrame sf = frame(fid);
        ReferenceType dt = sf.location().declaringType();
        if (!dt.allFields().stream().filter(TypeComponent::isStatic).findAny().isEmpty()) l.add(map("name", "Static", "variablesReference", ref(dt), "expensive", false));
        return map("scopes", l);
    }

    Object variables(Map<String, Object> a) throws Exception {
        need();
        Object target;
        synchronized (refs) { target = refs.get((int) num(a, "variablesReference", -1)); }
        if (target == null) throw new DapError("변수 참조가 만료됐습니다 (프로그램이 다시 실행됐습니다)");
        List<Object> out = new ArrayList<>();
        if (target instanceof FrameScope) {
            FrameScope fs = (FrameScope) target;
            StackFrame sf = fs.t.frame(fs.index);
            ObjectReference self = sf.thisObject();
            if (self != null) out.add(variable("this", self));
            try {
                List<LocalVariable> vars = sf.visibleVariables();
                Map<LocalVariable, Value> vals = sf.getValues(vars);
                for (LocalVariable v : vars) out.add(variable(v.name(), vals.get(v)));
            } catch (AbsentInformationException e) {
                List<Value> args = sf.getArgumentValues();
                for (int k = 0; k < args.size(); k++) out.add(variable("arg" + k, args.get(k)));
                out.add(map("name", "(참고)", "value", "지역 변수 정보가 없습니다 — javac -g / debug 빌드로 컴파일하세요", "variablesReference", 0));
            }
        } else if (target instanceof ArrayReference) {
            ArrayReference arr = (ArrayReference) target;
            int start = (int) num(a, "start", 0), count = (int) num(a, "count", 0);
            int len = arr.length();
            int n = count > 0 ? Math.min(count, len - start) : Math.min(len - start, 1000);
            List<Value> vs = n > 0 ? arr.getValues(start, n) : List.of();
            for (int k = 0; k < vs.size(); k++) out.add(variable("[" + (start + k) + "]", vs.get(k)));
        } else if (target instanceof ReferenceType) {
            ReferenceType t = (ReferenceType) target;
            for (Field f : t.allFields()) if (f.isStatic()) out.add(variable(f.name(), t.getValue(f)));
        } else if (target instanceof ObjectReference) {
            ObjectReference o = (ObjectReference) target;
            List<Field> fields = new ArrayList<>();
            for (Field f : o.referenceType().allFields()) if (!f.isStatic()) fields.add(f);
            Map<Field, Value> vals = o.getValues(fields);
            for (Field f : fields) out.add(variable(f.name(), vals.get(f)));
        }
        return map("variables", out);
    }

    Map<String, Object> variable(String name, Value v) {
        Map<String, Object> m = map("name", name, "value", display(v), "type", v == null ? null : v.type().name(), "variablesReference", expandable(v) ? ref(v) : 0);
        if (v instanceof ArrayReference) m.put("indexedVariables", ((ArrayReference) v).length());
        return m;
    }

    static boolean expandable(Value v) {
        if (v instanceof ArrayReference) return ((ArrayReference) v).length() > 0;
        return v instanceof ObjectReference && !(v instanceof StringReference) && boxed((ObjectReference) v) == null;
    }

    static final Set<String> BOXES = Set.of("java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte", "java.lang.Double", "java.lang.Float", "java.lang.Boolean", "java.lang.Character");
    static Value boxed(ObjectReference o) {
        if (!BOXES.contains(o.referenceType().name())) return null;
        Field f = o.referenceType().fieldByName("value");
        return f == null ? null : o.getValue(f);
    }

    static String display(Value v) {
        if (v == null) return "null";
        if (v instanceof StringReference) return quoteJava(((StringReference) v).value());
        if (v instanceof CharValue) return "'" + ((CharValue) v).value() + "'";
        if (v instanceof PrimitiveValue) return v.toString();
        if (v instanceof ArrayReference) {
            ArrayReference arr = (ArrayReference) v;
            String t = arr.type().name();
            int br = t.indexOf('[');
            StringBuilder b = new StringBuilder(t.substring(t.lastIndexOf('.', br) + 1, br)).append('[').append(arr.length()).append(']').append(t.substring(br + 2));
            if (arr.length() > 0 && arr.length() <= 20 && !(arr.getValue(0) instanceof ObjectReference) ) {
                b.append(" {");
                List<Value> vs = arr.getValues();
                for (int k = 0; k < vs.size(); k++) { if (k > 0) b.append(", "); b.append(display(vs.get(k))); }
                b.append('}');
            }
            return b.toString();
        }
        ObjectReference o = (ObjectReference) v;
        Value box = boxed(o);
        if (box != null) return display(box);
        ReferenceType t = o.referenceType();
        String name = t.name();
        String simple = name.substring(name.lastIndexOf('.') + 1);
        if (t instanceof ClassType && ((ClassType) t).isEnum()) {
            Field f = ((ClassType) t).superclass() != null ? ((ClassType) t).superclass().fieldByName("name") : null;
            Value n = f != null ? o.getValue(f) : null;
            if (n instanceof StringReference) return simple + "." + ((StringReference) n).value();
        }
        Field size = t.fieldByName("size");
        if (size == null && t instanceof ClassType) for (ClassType c = ((ClassType) t).superclass(); size == null && c != null; c = c.superclass()) size = c.fieldByName("size");
        Value sz = size != null && !size.isStatic() ? o.getValue(size) : null;
        return simple + (sz instanceof IntegerValue ? " size=" + ((IntegerValue) sz).value() : "") + " (id=" + o.uniqueID() + ")";
    }

    static String quoteJava(String s) {
        StringBuilder b = new StringBuilder("\"");
        int n = Math.min(s.length(), 2000);
        for (int k = 0; k < n; k++) {
            char c = s.charAt(k);
            switch (c) { case '\n': b.append("\\n"); break; case '\t': b.append("\\t"); break; case '\r': b.append("\\r"); break; case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; default: b.append(c); }
        }
        if (s.length() > n) b.append("…");
        return b.append('"').toString();
    }

    // ------------------------------------------------------------------ evaluate / setVariable
    Object evaluate(Map<String, Object> a) throws Exception {
        need();
        String expr = str(a, "expression");
        if (expr == null || expr.isBlank()) throw new DapError("식이 비어 있습니다");
        ThreadReference t; int index;
        if (a.get("frameId") instanceof Number) { Object[] f = frameEntry(num(a, "frameId", -1)); t = (ThreadReference) f[0]; index = (Integer) f[1]; }
        else if (stoppedThread != null) { t = stoppedThread; index = 0; }
        else throw new DapError("프로그램이 멈춰 있을 때만 평가할 수 있습니다");
        Object v = new Eval(this, t, index, true).run(expr.trim().replaceAll(";+$", ""));
        Value jv = v instanceof Value ? (Value) v : null;
        return map("result", v instanceof Value || v == null ? display(jv) : Eval.show(v), "type", jv != null ? jv.type().name() : v == null ? null : Eval.typeOf(v), "variablesReference", expandable(jv) ? ref(jv) : 0);
    }

    Object setVariable(Map<String, Object> a) throws Exception {
        need();
        Object target;
        synchronized (refs) { target = refs.get((int) num(a, "variablesReference", -1)); }
        String name = str(a, "name"), value = str(a, "value");
        if (target == null || name == null || value == null) throw new DapError("변수를 찾지 못했습니다");
        ThreadReference t = target instanceof FrameScope ? ((FrameScope) target).t : stoppedThread;
        if (t == null) throw new DapError("프로그램이 멈춰 있을 때만 바꿀 수 있습니다");
        int index = target instanceof FrameScope ? ((FrameScope) target).index : 0;
        Eval ev = new Eval(this, t, index, true);
        Object v = ev.run(value);
        Value set;
        if (target instanceof FrameScope) {
            StackFrame sf = t.frame(index);
            LocalVariable lv = sf.visibleVariableByName(name);
            if (lv == null) throw new DapError(name + " 지역 변수가 없습니다");
            set = ev.convert(v, lv.typeName());
            t.frame(index).setValue(lv, set);
        } else if (target instanceof ObjectReference && !(target instanceof ArrayReference)) {
            ObjectReference o = (ObjectReference) target;
            Field f = o.referenceType().fieldByName(name);
            if (f == null) throw new DapError(name + " 필드가 없습니다");
            set = ev.convert(v, f.typeName());
            o.setValue(f, set);
        } else if (target instanceof ArrayReference) {
            ArrayReference arr = (ArrayReference) target;
            int k = Integer.parseInt(name.replaceAll("[\\[\\]]", ""));
            String tn = arr.type().name();
            set = ev.convert(v, tn.substring(0, tn.length() - 2));
            arr.setValue(k, set);
        } else if (target instanceof ClassType) {
            ClassType c = (ClassType) target;
            Field f = c.fieldByName(name);
            if (f == null) throw new DapError(name + " 필드가 없습니다");
            set = ev.convert(v, f.typeName());
            c.setValue(f, set);
        } else throw new DapError("이 변수는 바꿀 수 없습니다");
        return map("value", display(set), "type", set == null ? null : set.type().name(), "variablesReference", expandable(set) ? ref(set) : 0);
    }

    /** A small Java-expression evaluator over JDI values (locals, fields, statics, arrays, operators, calls). */
    static final class Eval {
        final AidevJdi a; final ThreadReference t; final int index; final boolean invoke;
        List<String> toks; int k;
        Eval(AidevJdi a, ThreadReference t, int index, boolean invoke) { this.a = a; this.t = t; this.index = index; this.invoke = invoke; }

        static final class TypeRef { final ReferenceType type; TypeRef(ReferenceType t) { type = t; } }
        static final class Pkg { final String name; Pkg(String n) { name = n; } }

        static DapError err(String m) { return new DapError(m); }

        Object run(String expr) throws Exception {
            toks = lex(expr); k = 0;
            Object v = ternary();
            if (k < toks.size()) throw err("해석할 수 없는 부분: " + toks.get(k));
            if (v instanceof Pkg) throw err(((Pkg) v).name + "을(를) 찾지 못했습니다");
            if (v instanceof TypeRef) return ((TypeRef) v).type.classObject();
            return v;
        }

        static List<String> lex(String s) throws DapError {
            List<String> out = new ArrayList<>();
            int i = 0;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (Character.isWhitespace(c)) { i++; continue; }
                if (Character.isJavaIdentifierStart(c)) { int st = i; while (i < s.length() && Character.isJavaIdentifierPart(s.charAt(i))) i++; out.add(s.substring(st, i)); continue; }
                if (Character.isDigit(c) || c == '.' && i + 1 < s.length() && Character.isDigit(s.charAt(i + 1))) {
                    int st = i;
                    if (c == '0' && i + 1 < s.length() && (s.charAt(i + 1) == 'x' || s.charAt(i + 1) == 'X')) { i += 2; while (i < s.length() && (Character.digit(s.charAt(i), 16) >= 0 || s.charAt(i) == '_')) i++; }
                    else { while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '.' || s.charAt(i) == '_' || s.charAt(i) == 'e' || s.charAt(i) == 'E' || (s.charAt(i) == '-' || s.charAt(i) == '+') && (s.charAt(i - 1) == 'e' || s.charAt(i - 1) == 'E'))) i++; }
                    if (i < s.length() && "lLfFdD".indexOf(s.charAt(i)) >= 0) i++;
                    out.add(s.substring(st, i)); continue;
                }
                if (c == '"' || c == '\'') {
                    StringBuilder b = new StringBuilder().append(c); i++;
                    while (i < s.length() && s.charAt(i) != c) {
                        char d = s.charAt(i++);
                        if (d == '\\' && i < s.length()) { char e = s.charAt(i++); b.append(e == 'n' ? '\n' : e == 't' ? '\t' : e == 'r' ? '\r' : e == '0' ? '\0' : e); }
                        else b.append(d);
                    }
                    if (i >= s.length()) throw err("따옴표가 닫히지 않았습니다");
                    i++; out.add(b.toString()); continue;
                }
                String two = i + 1 < s.length() ? s.substring(i, i + 2) : "";
                if (List.of("==", "!=", "<=", ">=", "&&", "||", "<<", ">>").contains(two)) { out.add(two); i += 2; continue; }
                if ("+-*/%<>!()[].,?:&|^~".indexOf(c) >= 0) { out.add(String.valueOf(c)); i++; continue; }
                throw err("알 수 없는 문자: " + c);
            }
            return out;
        }

        String peek() { return k < toks.size() ? toks.get(k) : ""; }
        boolean eat(String s) { if (peek().equals(s)) { k++; return true; } return false; }
        void expect(String s) throws DapError { if (!eat(s)) throw err("'" + s + "'이(가) 필요합니다" + (k < toks.size() ? " (" + toks.get(k) + " 앞)" : "")); }

        Object ternary() throws Exception {
            Object c = or();
            if (!eat("?")) return c;
            Object x = ternary(); expect(":"); Object y = ternary();
            return truth(c) ? x : y;
        }
        Object or() throws Exception { Object l = and(); while (eat("||")) { boolean lv = truth(l); Object r = and(); l = lv || truth(r); } return l; }
        Object and() throws Exception { Object l = bitor(); while (eat("&&")) { boolean lv = truth(l); Object r = bitor(); l = lv && truth(r); } return l; }
        Object bitor() throws Exception { Object l = eq(); for (;;) { String op = peek(); if (op.equals("|") || op.equals("&") || op.equals("^")) { k++; l = arith(op, l, eq()); } else return l; } }
        Object eq() throws Exception {
            Object l = rel();
            for (;;) {
                if (eat("==")) l = equal(l, rel());
                else if (eat("!=")) l = !equal(l, rel());
                else return l;
            }
        }
        Object rel() throws Exception {
            Object l = shift();
            for (;;) {
                String op = peek();
                if (!List.of("<", ">", "<=", ">=").contains(op)) return l;
                k++;
                Object r = shift();
                double x = number(l).doubleValue(), y = number(r).doubleValue();
                l = op.equals("<") ? x < y : op.equals(">") ? x > y : op.equals("<=") ? x <= y : x >= y;
            }
        }
        Object shift() throws Exception { Object l = add(); for (;;) { String op = peek(); if (op.equals("<<") || op.equals(">>")) { k++; l = arith(op, l, add()); } else return l; } }
        Object add() throws Exception {
            Object l = mul();
            for (;;) {
                if (eat("+")) { Object r = mul(); l = isText(l) || isText(r) ? text(l) + text(r) : arith("+", l, r); }
                else if (eat("-")) l = arith("-", l, mul());
                else return l;
            }
        }
        Object mul() throws Exception { Object l = unary(); for (;;) { String op = peek(); if (op.equals("*") || op.equals("/") || op.equals("%")) { k++; l = arith(op, l, unary()); } else return l; } }
        Object unary() throws Exception {
            if (eat("!")) return !truth(unary());
            if (eat("-")) { Object v = unary(); return arith("-", 0, v); }
            if (eat("+")) return number(unary());
            if (eat("~")) return arith("^", unary(), -1);
            return postfix();
        }

        Object postfix() throws Exception {
            Object v = primary();
            for (;;) {
                if (eat(".")) {
                    String name = toks.size() > k ? toks.get(k++) : "";
                    if (peek().equals("(")) v = call(v, name, args());
                    else v = member(v, name);
                } else if (eat("[")) {
                    Object i = ternary(); expect("]");
                    Object arr = deref(v);
                    if (!(arr instanceof ArrayReference)) throw err("배열이 아닙니다");
                    int n = number(i).intValue();
                    ArrayReference ar = (ArrayReference) arr;
                    if (n < 0 || n >= ar.length()) throw err("인덱스 " + n + "이(가) 범위(0.." + (ar.length() - 1) + ")를 벗어났습니다");
                    v = ar.getValue(n);
                } else return v;
            }
        }

        List<Object> args() throws Exception {
            expect("(");
            List<Object> l = new ArrayList<>();
            if (eat(")")) return l;
            do l.add(ternary()); while (eat(","));
            expect(")");
            return l;
        }

        Object primary() throws Exception {
            String tok = toks.size() > k ? toks.get(k++) : "";
            if (tok.isEmpty()) throw err("식이 끝났습니다");
            if (tok.equals("(")) { Object v = ternary(); expect(")"); return v; }
            if (tok.startsWith("\"")) return tok.substring(1);
            if (tok.startsWith("'")) { if (tok.length() != 2) throw err("문자 리터럴이 잘못됐습니다"); return tok.charAt(1); }
            if (Character.isDigit(tok.charAt(0)) || tok.charAt(0) == '.') return literal(tok);
            switch (tok) {
                case "true": return true;
                case "false": return false;
                case "null": return null;
                case "this": { ObjectReference o = frame().thisObject(); if (o == null) throw err("static 메서드에는 this가 없습니다"); return o; }
                default:
            }
            if (!Character.isJavaIdentifierStart(tok.charAt(0))) throw err("해석할 수 없는 부분: " + tok);
            if (peek().equals("(")) {
                StackFrame f = frame();
                ObjectReference self = f.thisObject();
                return call(self != null ? self : new TypeRef(f.location().declaringType()), tok, args());
            }
            return name(tok);
        }

        static Object literal(String tok) throws DapError {
            String n = tok.replace("_", "");
            char last = Character.toLowerCase(n.charAt(n.length() - 1));
            try {
                if (n.startsWith("0x") || n.startsWith("0X")) { String h = last == 'l' ? n.substring(2, n.length() - 1) : n.substring(2); long v = Long.parseUnsignedLong(h, 16); return last == 'l' ? (Object) v : (Object) (int) v; }
                if (last == 'l') return Long.parseLong(n.substring(0, n.length() - 1));
                if (last == 'f') return Float.parseFloat(n.substring(0, n.length() - 1));
                if (last == 'd') return Double.parseDouble(n.substring(0, n.length() - 1));
                if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
                long v = Long.parseLong(n);
                return v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE ? (Object) (int) v : (Object) v;
            } catch (NumberFormatException e) { throw err("숫자가 잘못됐습니다: " + tok); }
        }

        StackFrame frame() throws Exception { return t.frame(index); }

        Object name(String n) throws Exception {
            StackFrame f = frame();
            try {
                LocalVariable lv = f.visibleVariableByName(n);
                if (lv != null) return f.getValue(lv);
            } catch (AbsentInformationException ignored) { /* no locals table */ }
            ObjectReference self = f.thisObject();
            if (self != null) { Field fl = self.referenceType().fieldByName(n); if (fl != null) return fl.isStatic() ? self.referenceType().getValue(fl) : self.getValue(fl); }
            ReferenceType dt = f.location().declaringType();
            Field sf = dt.fieldByName(n);
            if (sf != null && sf.isStatic()) return dt.getValue(sf);
            // outer classes' statics (lambdas, nested classes)
            for (String outer = dt.name(); outer.contains("$"); ) {
                outer = outer.substring(0, outer.lastIndexOf('$'));
                for (ReferenceType o : a.vm.classesByName(outer)) { Field of = o.fieldByName(n); if (of != null && of.isStatic()) return o.getValue(of); }
            }
            if (!peek().equals(".")) throw err("이름 " + n + "을(를) 찾지 못했습니다 (지역 변수·필드·static 어디에도 없음)");
            ReferenceType type = findType(n, dt);
            if (type != null) return new TypeRef(type);
            return new Pkg(n);
        }

        ReferenceType findType(String n, ReferenceType context) {
            String pkg = context == null ? "" : context.name().contains(".") ? context.name().substring(0, context.name().lastIndexOf('.') + 1) : "";
            for (String cand : new String[] { n, "java.lang." + n, pkg + n, context == null ? null : context.name() + "$" + n, "java.util." + n }) {
                if (cand == null) continue;
                List<ReferenceType> l = a.vm.classesByName(cand);
                if (!l.isEmpty()) return l.get(0);
            }
            return null;
        }

        Object member(Object v, String name) throws Exception {
            if (v instanceof Pkg) {
                String full = ((Pkg) v).name + "." + name;
                List<ReferenceType> l = a.vm.classesByName(full);
                if (!l.isEmpty()) return new TypeRef(l.get(0));
                if (!peek().equals(".")) throw err(full + "을(를) 찾지 못했습니다 (로드되지 않은 클래스이거나 없는 이름)");
                return new Pkg(full);
            }
            if (v instanceof TypeRef) {
                ReferenceType type = ((TypeRef) v).type;
                Field f = type.fieldByName(name);
                if (f != null && f.isStatic()) return type.getValue(f);
                if (name.equals("class")) return type.classObject();
                List<ReferenceType> nested = a.vm.classesByName(type.name() + "$" + name);
                if (!nested.isEmpty()) return new TypeRef(nested.get(0));
                throw err(type.name() + "에 static 필드 " + name + "이(가) 없습니다");
            }
            Object o = deref(v);
            if (o == null) throw err("null의 " + name + "에 접근했습니다 (NullPointerException)");
            if (o instanceof ArrayReference && name.equals("length")) return ((ArrayReference) o).length();
            if (o instanceof String && name.equals("length")) throw err("length()처럼 메서드로 호출하세요");
            if (!(o instanceof ObjectReference)) throw err(show(o) + "에는 필드가 없습니다");
            ObjectReference ref = (ObjectReference) o;
            Field f = ref.referenceType().fieldByName(name);
            if (f == null) throw err(ref.referenceType().name() + "에 필드 " + name + "이(가) 없습니다");
            return f.isStatic() ? ref.referenceType().getValue(f) : ref.getValue(f);
        }

        Object call(Object target, String name, List<Object> args) throws Exception {
            if (!invoke) throw err("조건식에서는 메서드를 호출하지 않습니다 (필드·변수·연산만)");
            if (target instanceof Pkg) throw err(((Pkg) target).name + "을(를) 찾지 못했습니다");
            ReferenceType type; ObjectReference obj = null;
            if (target instanceof TypeRef) type = ((TypeRef) target).type;
            else {
                Object o = deref(target);
                if (o == null) throw err("null에서 " + name + "()을 호출했습니다 (NullPointerException)");
                if (o instanceof String) o = mirror((String) o);
                if (!(o instanceof ObjectReference)) {
                    ReferenceType box = boxType(o);
                    if (box == null) throw err(show(o) + "에서 메서드를 호출할 수 없습니다");
                    o = convert(o, box.name());
                }
                obj = (ObjectReference) o;
                type = obj.referenceType();
            }
            DapError last = null;
            for (Method m : type.methodsByName(name)) {
                if (m.argumentTypeNames().size() != args.size() && !(m.isVarArgs() && args.size() >= m.argumentTypeNames().size() - 1)) continue;
                if (obj == null && !m.isStatic()) continue;
                List<Value> vals = new ArrayList<>();
                try {
                    List<String> types = m.argumentTypeNames();
                    if (m.isVarArgs() && !(args.size() == types.size() && (args.get(args.size() - 1) instanceof ArrayReference || args.get(args.size() - 1) == null))) {
                        for (int i = 0; i < types.size() - 1; i++) vals.add(convert(args.get(i), types.get(i)));
                        String at = types.get(types.size() - 1);
                        ArrayType arrType = (ArrayType) a.vm.classesByName(at).stream().findFirst().orElseThrow(() -> err(at + " 배열 타입이 로드되지 않았습니다"));
                        ArrayReference arr = arrType.newInstance(args.size() - types.size() + 1);
                        String et = at.substring(0, at.length() - 2);
                        for (int i = types.size() - 1; i < args.size(); i++) arr.setValue(i - types.size() + 1, convert(args.get(i), et));
                        vals.add(arr);
                    } else for (int i = 0; i < args.size(); i++) vals.add(convert(args.get(i), types.get(i)));
                } catch (DapError e) { last = e; continue; }
                a.invoking = t;
                try {
                    if (m.isStatic()) {
                        if (type instanceof ClassType) return ((ClassType) type).invokeMethod(t, m, vals, ObjectReference.INVOKE_SINGLE_THREADED);
                        return ((InterfaceType) type).invokeMethod(t, m, vals, ObjectReference.INVOKE_SINGLE_THREADED);
                    }
                    return obj.invokeMethod(t, m, vals, ObjectReference.INVOKE_SINGLE_THREADED);
                } catch (InvocationException e) {
                    throw err(name + "()이(가) 예외를 던졌습니다: " + a.exceptionText(e.exception()));
                } catch (IncompatibleThreadStateException e) {
                    throw err("메서드 호출은 중단점·스텝으로 멈췄을 때만 됩니다 (일시정지 상태에서는 불가)");
                } finally { a.invoking = null; }
            }
            if (last != null) throw last;
            throw err(type.name() + "에 인자 " + args.size() + "개인 " + (obj == null ? "static " : "") + "메서드 " + name + "이(가) 없습니다");
        }

        StringReference mirror(String s) { StringReference r = a.vm.mirrorOf(s); try { r.disableCollection(); } catch (RuntimeException ignored) { /* best effort */ } return r; }

        ReferenceType boxType(Object o) {
            String n = o instanceof Integer ? "java.lang.Integer" : o instanceof Long ? "java.lang.Long" : o instanceof Double ? "java.lang.Double" : o instanceof Float ? "java.lang.Float"
                : o instanceof Boolean ? "java.lang.Boolean" : o instanceof Character ? "java.lang.Character" : o instanceof Short ? "java.lang.Short" : o instanceof Byte ? "java.lang.Byte" : null;
            if (n == null) return null;
            List<ReferenceType> l = a.vm.classesByName(n);
            return l.isEmpty() ? null : l.get(0);
        }

        /** A local (Java) value or JDI value → a JDI Value assignable to typeName. */
        Value convert(Object v, String typeName) throws Exception {
            Object d = v instanceof Value ? v : v;
            if (d instanceof PrimitiveValue || d instanceof ObjectReference && !(d instanceof StringReference) && boxed((ObjectReference) d) != null && isPrimitiveName(typeName)) d = local(d);
            switch (typeName) {
                case "int": return a.vm.mirrorOf(number(d).intValue());
                case "long": return a.vm.mirrorOf(number(d).longValue());
                case "short": return a.vm.mirrorOf(number(d).shortValue());
                case "byte": return a.vm.mirrorOf(number(d).byteValue());
                case "float": return a.vm.mirrorOf(number(d).floatValue());
                case "double": return a.vm.mirrorOf(number(d).doubleValue());
                case "char": if (d instanceof Character) return a.vm.mirrorOf((Character) d); return a.vm.mirrorOf((char) number(d).intValue());
                case "boolean": if (d instanceof Boolean) return a.vm.mirrorOf((Boolean) d); throw err("boolean 값이 필요합니다");
                default:
            }
            if (d == null) return null;
            if (d instanceof String) {
                if (typeName.equals("java.lang.String") || typeName.equals("java.lang.Object") || typeName.equals("java.lang.CharSequence")) return mirror((String) d);
                throw err(typeName + " 자리에 문자열을 넣을 수 없습니다");
            }
            if (d instanceof ObjectReference) return (ObjectReference) d;
            // box a local primitive: Integer.valueOf(…) in the debuggee
            ReferenceType box = boxType(d);
            if (box == null) throw err(show(d) + "을(를) " + typeName + "(으)로 바꿀 수 없습니다");
            String prim = d instanceof Integer ? "int" : d instanceof Long ? "long" : d instanceof Double ? "double" : d instanceof Float ? "float" : d instanceof Boolean ? "boolean" : d instanceof Character ? "char" : d instanceof Short ? "short" : "byte";
            for (Method m : box.methodsByName("valueOf")) {
                if (m.argumentTypeNames().equals(List.of(prim))) {
                    a.invoking = t;
                    try { return ((ClassType) box).invokeMethod(t, m, List.of(convert(d, prim)), ObjectReference.INVOKE_SINGLE_THREADED); }
                    finally { a.invoking = null; }
                }
            }
            throw err(typeName + "(으)로 박싱하지 못했습니다");
        }

        static boolean isPrimitiveName(String n) { return List.of("int", "long", "short", "byte", "float", "double", "char", "boolean").contains(n); }

        /** JDI primitive / boxed value → Java value; others unchanged. */
        static Object local(Object v) {
            if (v instanceof ObjectReference && !(v instanceof StringReference)) { Value b = boxed((ObjectReference) v); if (b != null) v = b; }
            if (v instanceof BooleanValue) return ((BooleanValue) v).value();
            if (v instanceof CharValue) return ((CharValue) v).value();
            if (v instanceof IntegerValue) return ((IntegerValue) v).value();
            if (v instanceof LongValue) return ((LongValue) v).value();
            if (v instanceof ShortValue) return ((ShortValue) v).value();
            if (v instanceof ByteValue) return ((ByteValue) v).value();
            if (v instanceof FloatValue) return ((FloatValue) v).value();
            if (v instanceof DoubleValue) return ((DoubleValue) v).value();
            return v;
        }
        static Object deref(Object v) { return local(v); }

        static boolean isText(Object v) { return v instanceof String || v instanceof StringReference; }
        String text(Object v) throws Exception {
            v = local(v);
            if (v == null) return "null";
            if (v instanceof String) return (String) v;
            if (v instanceof StringReference) return ((StringReference) v).value();
            if (v instanceof ObjectReference) {
                if (!invoke) return display((ObjectReference) v);
                Object s = call(v, "toString", List.of());
                return s instanceof StringReference ? ((StringReference) s).value() : String.valueOf(s);
            }
            return String.valueOf(v);
        }
        static Number number(Object v) throws DapError {
            v = local(v);
            if (v instanceof Character) return (int) (Character) v;
            if (v instanceof Number) return (Number) v;
            throw err("숫자가 아닙니다: " + show(v));
        }
        static boolean truth(Object v) throws DapError {
            v = local(v);
            if (v instanceof Boolean) return (Boolean) v;
            throw err("boolean이 아닙니다: " + show(v));
        }
        static boolean equal(Object l, Object r) throws DapError {
            Object x = local(l), y = local(r);
            if (x == null || y == null) return x == y;
            if ((x instanceof Number || x instanceof Character) && (y instanceof Number || y instanceof Character)) {
                Number p = number(x), q = number(y);
                return p instanceof Double || p instanceof Float || q instanceof Double || q instanceof Float ? p.doubleValue() == q.doubleValue() : p.longValue() == q.longValue();
            }
            if (x instanceof String && y instanceof StringReference) return x.equals(((StringReference) y).value());
            if (y instanceof String && x instanceof StringReference) return y.equals(((StringReference) x).value());
            return x.equals(y);
        }
        static Object arith(String op, Object l, Object r) throws DapError {
            Object x = local(l), y = local(r);
            if (x instanceof Boolean && y instanceof Boolean && (op.equals("&") || op.equals("|") || op.equals("^"))) {
                boolean p = (Boolean) x, q = (Boolean) y;
                return op.equals("&") ? p & q : op.equals("|") ? p | q : p ^ q;
            }
            Number p = number(x), q = number(y);
            boolean dbl = p instanceof Double || q instanceof Double, flt = !dbl && (p instanceof Float || q instanceof Float), lng = p instanceof Long || q instanceof Long;
            if ((dbl || flt) && List.of("&", "|", "^", "<<", ">>").contains(op)) throw err(op + "는 정수에만 쓸 수 있습니다");
            if (dbl || flt) {
                double a = p.doubleValue(), b = q.doubleValue(), res;
                switch (op) { case "+": res = a + b; break; case "-": res = a - b; break; case "*": res = a * b; break; case "/": res = a / b; break; default: res = a % b; }
                return flt ? (Object) (float) res : (Object) res;
            }
            long a = p.longValue(), b = q.longValue(), res;
            if ((op.equals("/") || op.equals("%")) && b == 0) throw err("0으로 나눴습니다 (ArithmeticException)");
            switch (op) {
                case "+": res = a + b; break; case "-": res = a - b; break; case "*": res = a * b; break; case "/": res = a / b; break; case "%": res = a % b; break;
                case "&": res = a & b; break; case "|": res = a | b; break; case "^": res = a ^ b; break; case "<<": res = lng ? a << b : (int) a << b; break; default: res = lng ? a >> b : (int) a >> b;
            }
            return lng ? (Object) res : (Object) (int) res;
        }
        static String show(Object v) {
            if (v == null) return "null";
            if (v instanceof Value) return display((Value) v);
            if (v instanceof String) return quoteJava((String) v);
            if (v instanceof Character) return "'" + v + "'";
            if (v instanceof TypeRef) return ((TypeRef) v).type.name();
            return String.valueOf(v);
        }
        static String typeOf(Object v) {
            if (v instanceof String) return "java.lang.String";
            if (v instanceof Integer) return "int"; if (v instanceof Long) return "long"; if (v instanceof Double) return "double"; if (v instanceof Float) return "float";
            if (v instanceof Boolean) return "boolean"; if (v instanceof Character) return "char"; if (v instanceof Short) return "short"; if (v instanceof Byte) return "byte";
            return null;
        }
    }
}
