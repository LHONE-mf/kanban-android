@file:Suppress("DEPRECATION", "DEPRECATION_ERROR")

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }

val debugKeystore = System.getenv("KANBAN_DEBUG_KEYSTORE_PATH")
val debugSigningEnabled = !debugKeystore.isNullOrBlank()
val releaseKeystore = System.getenv("KANBAN_KEYSTORE_PATH")
val releaseStorePassword = System.getenv("KANBAN_STORE_PASSWORD")
val releaseKeyAlias = System.getenv("KANBAN_KEY_ALIAS")
val releaseKeyPassword = System.getenv("KANBAN_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseKeystore, releaseStorePassword, releaseKeyAlias, releaseKeyPassword
).all { !it.isNullOrBlank() }

android {
    namespace = "com.kanban.offline"
    compileSdk {
        version = release(37) { minorApiLevel = 0 }
    }

    defaultConfig {
        applicationId = "com.kanban.offline"
        minSdk = 30
        targetSdk = 35
        // A higher code is required for Android to accept an in-place update.
        versionCode = System.getenv("KANBAN_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = "0.4.5"
    }

    signingConfigs {
        if (debugSigningEnabled) {
            create("stableDebug") {
                storeFile = file(requireNotNull(debugKeystore))
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
        if (hasReleaseSigning) {
            create("persistentRelease") {
                storeFile = file(requireNotNull(releaseKeystore))
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (debugSigningEnabled) {
                signingConfig = signingConfigs.getByName("stableDebug")
            }
        }
        getByName("release") {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("persistentRelease")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("io.github.its-hazratbilal:android-ai-kit-chat:1.0.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.activity:activity-ktx:1.9.3")
}
