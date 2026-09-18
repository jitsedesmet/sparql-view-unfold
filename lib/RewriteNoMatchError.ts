/**
 * The unification of a triple pattern with a mapping head failing, which is ordinary rather than
 * exceptional: a pattern pinning a position to a term the head pins to another one matches nothing, and
 * unfolds to `FILTER(FALSE)` - the empty solution multiset.
 *
 * It is a class of its own so that the unfolding can catch **only** this. A bare `catch` would turn a
 * genuine bug - a `TypeError`, a broken mapping - into a silently empty branch, which is exactly the
 * failure this type was introduced to stop.
 */
export class RewriteNoMatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RewriteNoMatchError';
  }
}
