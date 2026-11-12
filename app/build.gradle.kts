plugins {
    id("com.android.application")
}

// CI 실행 번호로 버전을 올린다. 팀원이 새 APK를 덮어 설치할 수 있고, 첫 화면에서 버전을 확인할 수 있다.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
val commit = (System.getenv("GITHUB_SHA") ?: "local").take(7)

android {
    namespace = "com.squeecho.docviewer"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.squeecho.docviewer"
        minSdk = 29
        targetSdk = 36
        versionCode = buildNumber
        versionName = "0.2.$buildNumber ($commit)"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // 배포 키(릴리스 키) 하나로 세 경로를 서명한다: 팀원 직접 설치 APK, 갤럭시 스토어 APK(같은 파일), 플레이 업로드용 번들(AAB).
    // 키는 저장소에 넣지 않는다: CI 비밀값(RELEASE_KEYSTORE_*)을 환경 변수로 받는다(store/release-checklist.md).
    // 키가 없으면(로컬 빌드·비밀값 등록 전) 저장소의 디버그 키로 서명한다. 디버그 키로 서명한 파일은 스토어에 올릴 수 없다.
    // 공개 소스(scripts/publish-source.sh)에는 디버그 키를 넣지 않는다: 그때는 안드로이드 기본 디버그 키(~/.android)를 쓴다.
    val releaseStore = System.getenv("RELEASE_KEYSTORE_FILE")
    signingConfigs {
        getByName("debug") {
            val repoDebugKey = file("debug.keystore")
            if (repoDebugKey.exists()) storeFile = repoDebugKey
        }
        if (releaseStore != null) {
            create("release") {
                storeFile = file(releaseStore)
                storePassword = System.getenv("RELEASE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("RELEASE_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (releaseStore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        noCompress += "wasm"
    }
}

dependencies {
    androidTestImplementation("androidx.test:core:1.6.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}

// 뷰어 화면이 쓰는 rhwp(HWP)·react-pptx(PPT)·react-docx(Word)·SheetJS(엑셀)·pdf.js(PDF)는 저장소에 넣지 않고 빌드 전에 받아 둔다(scripts/fetch-vendor.sh).
tasks.named("preBuild") {
    val vendorDir = file("src/main/assets/viewer/vendor")
    doFirst {
        val missing = listOf(
            "rhwp.js", "rhwp_bg.wasm", "xlsx.full.min.js", "pptx-view.js", "pptx_wasm_bg.wasm",
            "docx-view.js", "docx-import-worker.js", "docx_wasm_bg.wasm", "formula.js", "office-crypto.js",
            "pdfjs/pdf.mjs", "pdfjs/pdf.worker.mjs",
        )
            .filterNot { File(vendorDir, it).isFile }
        if (missing.isNotEmpty()) {
            throw GradleException("뷰어 라이브러리가 없습니다: $missing — 먼저 scripts/fetch-vendor.sh 를 실행하세요.")
        }
    }
}
