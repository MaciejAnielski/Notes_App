// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorICloud",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapacitorICloud",
            targets: ["ICloudPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", branch: "main")
    ],
    targets: [
        .target(
            name: "ICloudPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Plugin")
    ]
)
