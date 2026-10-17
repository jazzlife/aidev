// NadoVibe 러너 — Android 서비스 앱 (deploy/aidev/android). The runner binary itself comes from deploy/aidev/runner
// (scripts/build-android.sh builds it for each ABI and then this project, which packages it as a native library).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "nadovibe-runner"
include(":app")
