// swift-tools-version: 6.0
import PackageDescription

// Built with xtool (https://xtool.sh) instead of Xcode: `bun run ios` from apps/client.
// CapApp-SPM is written by `cap sync`; it pulls in Capacitor and the Capacitor plugins.
let package = Package(
    name: "Noctis",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "Noctis", targets: ["Noctis"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "CapApp-SPM", path: "App/CapApp-SPM"),
    ],
    targets: [
        .target(
            name: "Noctis",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapApp-SPM", package: "CapApp-SPM"),
            ],
            // Both are symlinks to what `cap sync` copies; the app looks for them in its bundle.
            resources: [
                .copy("public"),
                .copy("capacitor.config.json"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
