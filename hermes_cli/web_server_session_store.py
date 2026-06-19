"""
Session store integration — appended to ``start_server`` in web_server.py.

After the auth gate is engaged (``app.state.auth_required = True``),
initialise the encrypted session cache and run a startup cleanup to
purge any expired sessions left from a prior run.

This snippet is the web_server.py diff for feat-001. The surrounding
``start_server`` function lives at L9265+ of the full web_server.py.
"""

# In ``start_server``, after ``app.state.auth_required = should_require_auth(...)``:
#
#   if app.state.auth_required:
#       # Initialise the persistent session cache so verified sessions
#       # survive gateway restarts.  The store is a best-effort cache —
#       # failure is logged but does not block startup (the IDP fallback
#       # path in the middleware handles the degraded case).
#       try:
#           from hermes_cli.dashboard_auth.session_store import SQLiteSessionStore
#           _store = SQLiteSessionStore()
#           # Prime the lazy singleton in the middleware so it doesn't
#           # re-init on every request's first cache miss.
#           from hermes_cli.dashboard_auth.middleware import _get_session_store
#           # _get_session_store returns its internal cache; if it's
#           # already populated we replace it, otherwise set it.
#           _get_session_store._instance = _store  # type: ignore[attr-defined]
#           _log.info("session store: initialised at %s", _store._db_path)
#           # Purge any sessions that expired while the gateway was down.
#           import asyncio
#           removed = asyncio.get_event_loop().run_until_complete(
#               _store.cleanup_expired()
#           )
#           if removed:
#               _log.info("session store: purged %d expired sessions on startup", removed)
#       except Exception:
#           _log.warning("session store: init failed, gateway runs without cache", exc_info=True)
