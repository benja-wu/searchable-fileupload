/**
 * Main HTTP server for uploading files into MongoDB GridFS with extended metadata.
 *
 * Features:
 * - Handles file uploads using Multer (temporary file storage on disk).
 * - Stores files in GridFS under bucket: abc_uploads.
 * - Generates metadata including:
 *      - name, type, keywords, briefing, sizeBytes, sourcePath
 * - If file is <= 10MB and type is JSON/XML/DOCX, extract text content and store it in:
 *      metadata.content   (string)
 * - Supports DOCX content extraction using 'mammoth'.
 * - Serves index page with upload form and file listing (with pagination).
 *
 * Notes:
 * - The metadata.content field enables full-text document search via Atlas Search.
 * - Requires a matching Atlas Search index definition that includes metadata fields,
 *   especially metadata.briefing and metadata.content (optionally with nGram analyzer).
 *
 * Auth:
 *   Benjamin Wu
 * 
 * Date:
 *   2025-12-09
 */

const express = require('express');
const multer = require('multer');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const os = require('os');
const fs = require('fs');
const mammoth = require('mammoth'); 

const app = express();

// === CONFIG ===
const MONGO_URI =  process.env.MONGODB_URI ||'mongodb+srv://abc.mongodb.net/?appName=ABCDemo';
const DB_NAME = process.env.DB_NAME || 'abc_demo';
const PORT = process.env.PORT || 3000;

const DEFAULT_PAGE_SIZE = 20;

// Parse regular form fields
app.use(express.urlencoded({ extended: true }));

// Multer: store uploads in temp folder
const upload = multer({
  dest: os.tmpdir(),
});

let db;
let bucket;

// Start MongoDB connection + web server
async function start() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);
  bucket = new GridFSBucket(db, { bucketName: 'abc_uploads' });

  const registerSearchRoutes = require("./search");
  registerSearchRoutes(app, db, bucket);

  app.listen(PORT, () =>
    console.log(`Server running at http://localhost:${PORT}`)
  );
}

// =========================
//          HOME PAGE
// =========================
app.get('/', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize) || DEFAULT_PAGE_SIZE, 1);

    const filesColl = db.collection('abc_uploads.files');

    const totalDocs = await filesColl.countDocuments();
    const totalPages = Math.max(Math.ceil(totalDocs / pageSize), 1);

    const files = await filesColl
      .find({})
      .sort({ uploadDate: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    const rows = files.map((file, i) => {
      const sizeKB = (file.length / 1024).toFixed(2);
      const dateStr = new Date(file.uploadDate).toLocaleString();

      const md = file.metadata || {};
      const displayName = md.name || file.filename;
      const displayType = md.type || file.contentType || '';
      const keywords = Array.isArray(md.keywords) ? md.keywords.join(', ') : (md.keywords || '');
      const briefing = md.briefing || '';

      return `
        <tr>
          <td>${(page - 1) * pageSize + i + 1}</td>
          <td>${displayName}</td>
          <td>${file.filename}</td>
          <td>${displayType}</td>
          <td>${sizeKB} KB</td>
          <td>${dateStr}</td>
          <td>${keywords}</td>
          <td>${briefing}</td>
          <td><a href="/files/${file._id}">Download</a></td>
        </tr>
      `;
    }).join('');

    // Page navigation
    const prevLink = page > 1 ? `<a href="/?page=${page - 1}&pageSize=${pageSize}">« Previous</a>` : "";
    const nextLink = page < totalPages ? `<a href="/?page=${page + 1}&pageSize=${pageSize}">Next »</a>` : "";

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>File Upload with Metadata</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; max-width: 1100px; margin: auto; }
          form { margin: 20px 0; padding: 16px; border: 1px solid #ccc; border-radius: 10px; background: #fafafa; }
          label { font-weight: 600; display: block; margin-top: 8px; }
          input[type="text"], textarea { width: 100%; padding: 6px; margin-top: 4px; }
          input[type="file"] { margin-top: 4px; }
          table { width: 100%; border-collapse: collapse; margin-top: 24px; }
          th, td { padding: 8px; border-bottom: 1px solid #eee; }
          th { background: #f2f2f2; }
          tr:hover { background: #f9f9f9; }
          .pagination { margin-top: 20px; font-size: 1.1rem; }
          .pagination a { margin-right: 20px; }
          .info { margin-bottom: 10px; color: #555; }
        </style>
      </head>
      <body>
        <h1>Upload File to MongoDB</h1>

        <form action="/upload" method="POST" enctype="multipart/form-data">
          <label>Select file</label>
          <input type="file" name="file" required />

          <label>Display name</label>
          <input type="text" name="displayName" />

          <label>Type</label>
          <input type="text" name="type" placeholder="e.g. iso, pbf, txt, mp4" />

          <label>Keywords (comma separated)</label>
          <input type="text" name="keywords" placeholder="ubuntu, demo, dataset" />

          <label>Briefing</label>
          <textarea name="briefing" rows="3"></textarea>

          <button type="submit">Upload</button>
        </form>

        <h2>Uploaded Files</h2>

        <div class="info">
          Showing page ${page} / ${totalPages}. Total files: ${totalDocs}.
        </div>

        ${
          files.length === 0
            ? "<p>No files uploaded.</p>"
            : `
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Display Name</th>
                    <th>Stored Filename</th>
                    <th>Type</th>
                    <th>Size</th>
                    <th>Uploaded</th>
                    <th>Keywords</th>
                    <th>Briefing</th>
                    <th>Download</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            `
        }

        <div class="pagination">
          ${prevLink}
          ${nextLink}
        </div>

      </body>
      </html>
    `);

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading page");
  }
});

function shouldExtractContent(file) {
  if (!file || !file.mimetype) return false;
  const mt = file.mimetype.toLowerCase();

  // JSON
  if (mt === 'application/json' || mt === 'text/json') return true;

  // XML (including +xml variants like application/rss+xml)
  if (mt === 'application/xml' || mt === 'text/xml' || mt.endsWith('+xml')) return true;

  // DOCX
  if (mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return true;
  }

  return false;
}


// =========================
//     UPLOAD ROUTE
// =========================
// Upload Route
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    const tmpFilePath = req.file.path;
    const fileSize = req.file.size;                 // bytes
    const mimeType = (req.file.mimetype || '').toLowerCase();

    const { displayName, type, keywords, briefing } = req.body;

    const keywordArray = keywords
      ? keywords.split(',').map(k => k.trim()).filter(Boolean)
      : [];

    // ---- NEW: optional content extraction based on MIME type ----
    let contentString = undefined;
    const TEN_MB = 10 * 1024 * 1024;

    if (fileSize <= TEN_MB && shouldExtractContent(req.file)) {
      try {
        if (mimeType === 'application/json' || mimeType === 'text/json') {
          contentString = await fs.promises.readFile(tmpFilePath, 'utf8');
        } else if (
          mimeType === 'application/xml' ||
          mimeType === 'text/xml' ||
          mimeType.endsWith('+xml')
        ) {
          contentString = await fs.promises.readFile(tmpFilePath, 'utf8');
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
          const result = await mammoth.extractRawText({ path: tmpFilePath });
          contentString = result.value || '';
        }
      } catch (e) {
        console.error('Content extraction failed:', e);
        // don’t fail the upload, just skip content
        contentString = undefined;
      }
    }

    const metadata = {
      name: displayName || req.file.originalname,
      type: type || mimeType,
      keywords: keywordArray,
      briefing: briefing || "",
      sizeBytes: fileSize,
      sourcePath: req.file.originalname
    };

    if (contentString && contentString.length > 0) {
      metadata.content = contentString;        
    }

    const readStream = fs.createReadStream(tmpFilePath);
    const uploadStream = bucket.openUploadStream(req.file.originalname, {
      contentType: mimeType,
      metadata
    });

    readStream.pipe(uploadStream);

    uploadStream.on('finish', () => {
      fs.unlinkSync(tmpFilePath);
      res.redirect('/');
    });

    uploadStream.on('error', err => {
      console.error("Upload error:", err);
      res.status(500).send("Upload failed");
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});


// =========================
//  PAGED JSON FILE LIST API
// =========================
app.get('/files', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.max(parseInt(req.query.pageSize) || DEFAULT_PAGE_SIZE, 1);

    const coll = db.collection("abc_uploads.files");

    const totalDocs = await coll.countDocuments();
    const totalPages = Math.max(Math.ceil(totalDocs / pageSize), 1);

    const files = await coll
      .find({})
      .sort({ uploadDate: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    res.json({
      page,
      pageSize,
      totalDocs,
      totalPages,
      files
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error listing files" });
  }
});

// =========================
//         DOWNLOAD
// =========================
app.get('/files/:id', async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);

    const fileDoc = await db.collection('abc_uploads.files').findOne({ _id: id });
    if (!fileDoc) return res.status(404).send("File not found");

    res.setHeader('Content-Type', fileDoc.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileDoc.filename}"`);

    bucket.openDownloadStream(id).pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).send("Download error");
  }
});

// =========================
//      START SERVER
// =========================
start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});

