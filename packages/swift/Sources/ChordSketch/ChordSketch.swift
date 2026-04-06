// Re-export all UniFFI-generated bindings.
// The actual Swift source is generated at build time by the CI workflow
// and placed in this directory before the XCFramework is assembled.
//
// For local development, generate bindings with:
//   cargo run -p chordsketch-ffi --bin uniffi-bindgen generate \
//     --library target/debug/libchordsketch_ffi.dylib \
//     --language swift \
//     --out-dir packages/swift/Sources/ChordSketch
