/**
 * Where the portal's attachments live, now that there is no Drive.
 *
 * Purchase orders, tax invoices, delivery photographs, service proofs and the generated
 * quotation PDFs. On Apps Script these went to Drive folders owned by the script's owner;
 * here they go to a directory on the server, and the portal cannot tell the difference
 * because this file answers the same five calls Documents.gs makes.
 *
 * WHY THE FILESYSTEM AND NOT POSTGRES. Not preference — the portal's own shape decides it.
 * `storeDriveFile_` is a synchronous function:
 *
 *     var folders = DriveApp.getFoldersByName(options.folder);
 *     var folder  = folders.hasNext() ? folders.next() : DriveApp.createFolder(options.folder);
 *     var file    = folder.createFile(blob);
 *     return { fileId: file.getId(), ... };
 *
 * Four calls, no `await`, and the codemod could not have added one: `folder.createFile` is a
 * method on a returned object, which a call graph cannot see. A database write in Node is
 * asynchronous, so a Postgres-backed Drive would have to return a promise where the portal
 * expects a file — and the row recording the attachment would be written before the bytes
 * were. `fs.writeFileSync` is synchronous, so the shim below is honestly synchronous, and a
 * file exists before the row that points at it does.
 *
 * WHAT THIS COSTS. The directory is not in the database, so it is not in the database's
 * backup. Whatever runs this needs its files directory on a disk that survives a restart —
 * a volume on Railway or Render, an ordinary directory on a VPS — and in the backup. That
 * is stated here rather than discovered later; see web/../docs and the README.
 *
 * LAYOUT, per tenant:
 *     <dir>/<tenant>/<id>.bin     the bytes
 *     <dir>/<tenant>/<id>.json    name, type, size, folder, who, when, trashed
 *     <dir>/<tenant>/folders/<slug>   a marker naming a folder that exists
 *
 * Ids are 32 random hex characters, like Drive's own: opaque, unguessable, and safe to put
 * in a path once checked against the pattern. Everything that touches the filesystem checks.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID = /^[0-9a-f]{32}$/;
const DEFAULT_DIR = path.join(__dirname, '..', 'var', 'files');

/** A tenant or folder name, reduced to something that is certainly one path segment. */
function slug(name) {
  const out = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'default';
}

/**
 * @param options  dir, tenant, actor, maxBytes
 * @return         { DriveApp, read, meta, stat, purgeTrashed, dir }
 */
function fileStore(options) {
  const o = options || {};
  const root = o.dir || process.env.ERP_FILES_DIR || DEFAULT_DIR;
  const dir = path.join(root, slug(o.tenant || 'default'));
  const folders = path.join(dir, 'folders');
  // A megabyte more than the portal's own 10 MB limit, so the portal's message about the
  // limit is the one people see rather than this one.
  const maxBytes = o.maxBytes || 11 * 1024 * 1024;

  const binOf = (id) => path.join(dir, id + '.bin');
  const metaOf = (id) => path.join(dir, id + '.json');

  function checked(id) {
    const s = String(id || '');
    if (!ID.test(s)) throw new Error('No such file.');
    return s;
  }

  function readMeta(id) {
    try { return JSON.parse(fs.readFileSync(metaOf(checked(id)), 'utf8')); }
    catch (err) { return null; }
  }

  function writeMeta(id, m) {
    fs.writeFileSync(metaOf(id), JSON.stringify(m, null, 2));
  }

  /** The file object the portal is handed back, with the methods it actually calls. */
  function fileFor(id) {
    return {
      getId: () => id,
      getName: () => (readMeta(id) || {}).name || '',
      getSize: () => (readMeta(id) || {}).size || 0,
      getMimeType: () => (readMeta(id) || {}).mimeType || 'application/octet-stream',
      // Relative on purpose. The server signs it on the way out, so what the browser gets
      // is /files/<id>?t=<signature> — a link that works in a new tab and stops working
      // later. Storing the signature would be storing something that expires.
      getUrl: () => '/files/' + id,
      getDownloadUrl: () => '/files/' + id + '?download=1',
      getBlob: () => {
        const m = readMeta(id) || {};
        const buf = fs.readFileSync(binOf(id));
        return {
          getBytes: () => Array.from(buf),
          getDataAsString: () => buf.toString('utf8'),
          getContentType: () => m.mimeType || 'application/octet-stream',
          getName: () => m.name || ''
        };
      },
      // Drive's bin, not a delete: Documents.gs says so in as many words, and a purchase
      // order removed by the wrong click is worth keeping for a while.
      setTrashed: (yes) => {
        const m = readMeta(id);
        if (!m) return;
        m.trashed = yes === false ? null : new Date().toISOString();
        writeMeta(id, m);
      },
      isTrashed: () => !!(readMeta(id) || {}).trashed
    };
  }

  function folderFor(name) {
    return {
      getName: () => name,
      getId: () => 'folder:' + slug(name),
      getUrl: () => '/files/',
      createFile: (blob) => {
        if (!blob || typeof blob.getBytes !== 'function') {
          throw new Error('createFile needs a blob.');
        }
        const bytes = blob.getBytes();
        const buf = Buffer.isBuffer(bytes) ? bytes
          : Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));
        if (buf.length > maxBytes) {
          throw new Error('That file is ' + Math.round(buf.length / 1024 / 1024 * 10) / 10 +
            ' MB, which is more than this server stores.');
        }
        fs.mkdirSync(dir, { recursive: true });
        const id = crypto.randomBytes(16).toString('hex');
        // The bytes first, then the record of them. The other order can leave a sidecar
        // describing a file that does not exist, which reads as corruption rather than as
        // an interrupted upload.
        fs.writeFileSync(binOf(id), buf);
        writeMeta(id, {
          name: blob.getName ? blob.getName() : 'file',
          mimeType: blob.getContentType ? blob.getContentType() : 'application/octet-stream',
          size: buf.length,
          folder: name,
          uploadedBy: o.actor || '',
          uploadedAt: new Date().toISOString(),
          trashed: null
        });
        return fileFor(id);
      }
    };
  }

  return {
    dir,

    DriveApp: {
      getFoldersByName: (name) => {
        const marker = path.join(folders, slug(name));
        const found = fs.existsSync(marker) ? [folderFor(name)] : [];
        let i = 0;
        return { hasNext: () => i < found.length, next: () => found[i++] };
      },
      createFolder: (name) => {
        fs.mkdirSync(folders, { recursive: true });
        fs.writeFileSync(path.join(folders, slug(name)), String(name));
        return folderFor(name);
      },
      getFolderById: (id) => folderFor(String(id).replace(/^folder:/, '')),
      getFileById: (id) => {
        const s = checked(id);
        if (!fs.existsSync(binOf(s))) throw new Error('No such file.');
        return fileFor(s);
      }
    },

    /** For the HTTP route: the bytes and what they are, or null. Trashed files are gone. */
    read: (id) => {
      let s;
      try { s = checked(id); } catch (err) { return null; }
      const m = readMeta(s);
      if (!m || m.trashed) return null;
      if (!fs.existsSync(binOf(s))) return null;
      return { bytes: fs.readFileSync(binOf(s)), name: m.name,
        mimeType: m.mimeType || 'application/octet-stream', size: m.size };
    },

    meta: readMeta,

    /** What is in here, for an operator wondering how big it has grown. */
    stat: () => {
      if (!fs.existsSync(dir)) return { files: 0, bytes: 0, trashed: 0 };
      let files = 0, bytes = 0, trashed = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const m = readMeta(f.slice(0, -5));
        if (!m) continue;
        files++;
        bytes += Number(m.size) || 0;
        if (m.trashed) trashed++;
      }
      return { files, bytes, trashed };
    },

    /**
     * Throws away what has been in the bin longer than Drive would have kept it. Nothing
     * calls this yet — it is here so that when the directory does need sweeping, the rule
     * is already written down rather than invented in a hurry.
     */
    purgeTrashed: (days) => {
      const cutoff = Date.now() - (days || 30) * 86400000;
      let gone = 0;
      if (!fs.existsSync(dir)) return gone;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        const m = readMeta(id);
        if (!m || !m.trashed || Date.parse(m.trashed) > cutoff) continue;
        try { fs.unlinkSync(binOf(id)); } catch (err) { /* already gone */ }
        try { fs.unlinkSync(metaOf(id)); gone++; } catch (err) { /* already gone */ }
      }
      return gone;
    }
  };
}

module.exports = { fileStore, slug };
