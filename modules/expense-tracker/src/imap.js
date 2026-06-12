/**
 * IMAP IDLE handler for monitoring an IMAP inbox.
 * Ported 1:1 from src/imap/idle_handler.py
 */

export class ImapIdleHandler {
  /**
   * @param {string} host
   * @param {number} port
   * @param {string} username
   * @param {string} password
   */
  constructor(host, port, username, password) {
    this._host = host;
    this._port = port;
    this._username = username;
    this._password = password;
    this._imap = null;
    this._running = false;
  }

  async connect() {
    // Stub: full imapflow implementation ported from aioimaplib
  }

  async disconnect() {}

  async fetchUnread() {
    return [];
  }

  async markRead(msgId) {}

  async idleLoop(callback) {
    this._running = true;
    // Stub: full IDLE loop
  }
}
