// Edit locks (GitHub #6). The first browser to open a Brew (or Library Blend) can edit it;
// anyone else gets it read-only until it's released or they take over.
//
// A lock belongs to a *client* — one browser profile, identified by an id kept in localStorage —
// not to a tab. So your own tabs never lock each other out (DocuBrew's save-conflict check covers
// two tabs editing the same file), but a second person or a second browser does get locked out.

export class Locks {
  constructor() {
    this.locks = new Map(); // path → { clientId, user, sessions: Set<sid>, since }
  }

  status(target, session) {
    const lock = this.locks.get(target);
    if (!lock || lock.clientId === session.clientId) return { editable: true, holder: null };
    return { editable: false, holder: lock.user, since: lock.since };
  }

  /** Try to take the lock. Returns { editable, holder?, since? }. */
  acquire(target, session) {
    const lock = this.locks.get(target);
    if (!lock) {
      this.locks.set(target, { clientId: session.clientId, user: session.user, sessions: new Set([session.id]), since: Date.now() });
      return { editable: true, holder: null };
    }
    if (lock.clientId === session.clientId) {
      lock.sessions.add(session.id);
      lock.user = session.user;
      return { editable: true, holder: null };
    }
    return { editable: false, holder: lock.user, since: lock.since };
  }

  /** A session stopped using `target` (opened something else, closed, or timed out). */
  release(target, session) {
    const lock = this.locks.get(target);
    if (!lock || lock.clientId !== session.clientId) return;
    lock.sessions.delete(session.id);
    if (!lock.sessions.size) this.locks.delete(target);
  }

  /** Take the lock from whoever has it. Returns the session ids that lost it. */
  takeOver(target, session) {
    const old = this.locks.get(target);
    if (old && old.clientId === session.clientId) return this.acquire(target, session), [];
    const lost = old && old.clientId !== session.clientId ? [...old.sessions] : [];
    this.locks.set(target, { clientId: session.clientId, user: session.user, sessions: new Set([session.id]), since: Date.now() });
    return lost;
  }

  /** Who (other than this client) is editing a path — for the Brew list. */
  holderFor(target, clientId) {
    const lock = this.locks.get(target);
    return lock && lock.clientId !== clientId ? lock.user : null;
  }

  isLockedByOther(target, clientId) {
    return Boolean(this.holderFor(target, clientId));
  }
}
