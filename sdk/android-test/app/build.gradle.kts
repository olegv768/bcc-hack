plugins {
    id("com.android.application")
}

android {
    namespace = "kz.example.dropperguard.test"
    compileSdk = 37

    defaultConfig {
        applicationId = "kz.example.dropperguard.test"
        minSdk = 24
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    // Проверяем те самые файлы модуля из sdk/android, а не их копию.
    sourceSets.named("main") {
        kotlin.directories += "../../android"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
