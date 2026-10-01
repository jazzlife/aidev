// the package's `export =` typing; its API type is not exported by name
type Highlighter = typeof import('highlight.js');

let loading: Promise<Highlighter> | null = null;

/**
 * Used by FilePeek: highlight.js core with the eight grammars of `languageFor`, loaded on the first peek so
 * the chat's initial bundle does not carry it (§3.11 budget).
 */
export function loadHighlighter(): Promise<Highlighter> {
  loading ??= Promise.all([
    import('highlight.js/lib/core'),
    import('highlight.js/lib/languages/typescript'),
    import('highlight.js/lib/languages/javascript'),
    import('highlight.js/lib/languages/json'),
    import('highlight.js/lib/languages/xml'),
    import('highlight.js/lib/languages/css'),
    import('highlight.js/lib/languages/python'),
    import('highlight.js/lib/languages/bash'),
    import('highlight.js/lib/languages/yaml'),
  ]).then(([core, typescript, javascript, json, xml, css, python, bash, yaml]) => {
    const hljs = core.default;
    hljs.registerLanguage('typescript', typescript.default);
    hljs.registerLanguage('javascript', javascript.default);
    hljs.registerLanguage('json', json.default);
    hljs.registerLanguage('xml', xml.default);
    hljs.registerLanguage('css', css.default);
    hljs.registerLanguage('python', python.default);
    hljs.registerLanguage('bash', bash.default);
    hljs.registerLanguage('yaml', yaml.default);
    return hljs;
  }).catch((error: unknown) => { loading = null; throw error; });
  return loading;
}
