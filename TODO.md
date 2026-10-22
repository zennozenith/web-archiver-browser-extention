### 4. Pending queue → tags flow (extension side, optional but nice)

`POST /api/pending` accepts no tags on either server. If "queue an URL with tags,
then archive it later" is wanted:

- Extension: extend `refreshPending`/pending item storage to carry `tags`, keep
  them in `browser.storage.local`, and when the queued URL is finally archived,
  prepend the stored tags to the `tags` payload of `ARCHIVE_TAB` (they'll be
  created server-side if new).
- Server (optional alternative): accept `tags` in `POST /api/pending` and merge
  them on `DELETE ...complete`/archive completion.

### 5. Badge & banner polish (optional)

- The badge tooltip could append the site's tag names: they are already available
  in `ArchiveOkStatus.tags` inside `applyStatusBadge`.
- `injectBanner(..., "prompt")` in `handleOpened` (direct-archive mode) could offer
  a tag chip row before confirming.
