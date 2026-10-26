// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ChordSketch",
    platforms: [
        .macOS(.v12),
        .iOS(.v15),
    ],
    products: [
        .library(
            name: "ChordSketch",
            targets: ["ChordSketch"]
        ),
    ],
    targets: [
        .binaryTarget(
            name: "chordsketchFFI",
            url: "https://github.com/koedame/chordsketch/releases/download/v0.9.0/chordsketch-xcframework.zip",
            checksum: "6d796deacb105fc9df196993073306ebf14a118f51d207f45b9f9d9882b7cdf4"
        ),
        .target(
            name: "ChordSketch",
            dependencies: ["chordsketchFFI"],
            path: "packages/swift/Sources/ChordSketch",
            linkerSettings: [
                // chordsketch-render-pdf depends on flate2 which uses
                // the system zlib for compression on Apple platforms.
                .linkedLibrary("z"),
            ]
        ),
        .testTarget(
            name: "ChordSketchTests",
            dependencies: ["ChordSketch"],
            path: "packages/swift/Tests"
        ),
    ]
)
