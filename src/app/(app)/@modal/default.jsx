// Parallel-route default: whenever the current URL doesn't match anything
// inside app/(app)/@modal (i.e. almost always), render nothing so the modal
// slot never shows stale content on unrelated pages.
export default function Default() {
  return null
}
