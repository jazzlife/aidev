// The app's version is the runner's (deploy/aidev/runner/Cargo.toml): one number for the APK and the binary in it.
// The runner binaries: build/jni/<abi>/libaidevrunner.so, put there by deploy/aidev/runner/scripts/build-android.sh.
// Release signing: AIDEV_ANDROID_KEYSTORE (+ _PASSWORD, _KEY_ALIAS, _KEY_PASSWORD) — the same key for every release,
// or Android refuses the update over an installed app. Without it the release is signed with the debug key (local tests).
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val runnerVersion: String = File(rootDir, "../runner/Cargo.toml").readLines()
    .first { it.startsWith("version = ") }.substringAfter('"').substringBefore('"')
val versionParts = runnerVersion.split('.').map { it.toInt() }
val keystore: String? = System.getenv("AIDEV_ANDROID_KEYSTORE")?.takeIf { it.isNotBlank() && File(it).isFile }

android {
    namespace = "work.nado.aidev.runner"
    compileSdk = 36

    defaultConfig {
        applicationId = "work.nado.aidev.runner"
        minSdk = 24
        targetSdk = 35
        versionName = runnerVersion
        versionCode = versionParts[0] * 1_000_000 + versionParts[1] * 1_000 + versionParts[2]
    }

    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = File(keystore)
                storePassword = System.getenv("AIDEV_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("AIDEV_ANDROID_KEY_ALIAS") ?: "nadovibe"
                keyPassword = System.getenv("AIDEV_ANDROID_KEY_PASSWORD") ?: System.getenv("AIDEV_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("jni"))

    // the runner is started as a program (ProcessBuilder), so it has to be a real file in nativeLibraryDir
    packaging {
        jniLibs.useLegacyPackaging = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
    lint {
        // the app is installed from the platform (sideloaded APK), not from Play: all-files access is the point
        disable += setOf("ScopedStorage", "BatteryLife", "ExpiredTargetSdkVersion")
    }
}

kotlin {
    jvmToolchain(17)
}

if (keystore == null) {
    logger.warn("AIDEV_ANDROID_KEYSTORE 없음 — release APK를 debug 키로 서명합니다 (설치된 앱 위로 업데이트되지 않을 수 있음)")
}
