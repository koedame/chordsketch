// C ABI of the `chordsketch-preview-handler` static library, as the
// Quick Look extension's Swift code sees it. Implemented in
// apps/desktop/preview-handler/src/quicklook.rs; a unit test there
// fails if a function is declared here but not exported.

#include <stddef.h>
#include <stdint.h>

// Number of bytes to read from the previewed file: enough for
// chordsketch_quicklook_render to tell an oversized file apart without
// the extension loading all of it.
size_t chordsketch_quicklook_read_limit(void);

// Renders the bytes of a ChordPro file into a UTF-8 HTML document and
// writes its length to `html_len`. Never returns null: a file that
// cannot be rendered produces a document saying why. `source` may be
// null only when `source_len` is 0. Release the result with
// chordsketch_quicklook_free.
uint8_t *_Nonnull chordsketch_quicklook_render(const uint8_t *_Nullable source,
                                               size_t source_len,
                                               size_t *_Nonnull html_len);

// Releases a buffer returned by chordsketch_quicklook_render.
void chordsketch_quicklook_free(uint8_t *_Nonnull html, size_t html_len);
