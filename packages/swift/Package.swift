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
            url: "https://github.com/koedame/chordsketch/releases/download/v0.2.1/chordsketch-xcframework.zip",
            checksum: "2d613c46cc067f12db022a09f1021eee86e73189b86ef7b94ac9f0aee818c5e1"
        ),
        .target(
            name: "ChordSketch",
            dependencies: ["chordsketchFFI"],
            path: "Sources/ChordSketch",
            linkerSettings: [
                // chordsketch-render-pdf depends on flate2 which uses
                // the system zlib for compression on Apple platforms.
                .linkedLibrary("z"),
            ]
        ),
        .testTarget(
            name: "ChordSketchTests",
            dependencies: ["ChordSketch"],
            path: "Tests"
        ),
    ]
)
