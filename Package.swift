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
            url: "https://github.com/koedame/chordsketch/releases/download/v0.8.0/chordsketch-xcframework.zip",
            checksum: "4dce019559532e023485ee18d43c9d5831f11acc19295e25eb0bc394319d2ccd"
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
