/**
 * Provides an HTTP route and UI for performing Atlas Search queries
 * against the GridFS metadata stored in abc_uploads.files.
 *
 * Features:
 * - Connects to MongoDB Atlas and runs an aggregation pipeline with $search.
 * - Default index assumed to be named "default".
 * - Compound search pipeline supports:
 *      - SHOULD match on metadata.name, metadata.keywords, metadata.type, metadata.sourcePath(autocomplete + fuzzy)
 *      - SHOULD match on metadata.briefing (boosted)
 *      - SHOULD match on metadata.content (text extracted from JSON/XML/DOCX files)
 * - Includes minimumShouldMatch logic to reduce noisy/unrelated results.
 * - Displays search form, results table, relevance scores, and GridFS download links.
 *
 * Notes:
 * - Requires Atlas Search index configuration that maps:
 *      metadata.name        -> autocomplete
 *      metadata.briefing    -> nGram or string
 *      metadata.content     -> string 
 *
 * Auth:
 *   Benjamin Wu
 * 
 * Date:
 *   2025-12-10
 */
console.log("[search.js] module loaded");

const { ObjectId } = require("mongodb");

// Simple HTML escaper to avoid injecting raw values into HTML
function escapeHtml(str) {
  if (!str && str !== 0) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}


// Build a sub-table with ALL highlight entries and ALL texts per entry
function buildHighlightTable(highlights) {
  if (!Array.isArray(highlights) || highlights.length === 0) return "";

  const AROUND_LEN = 80;        // how much context to keep for each non-hit segment
  const MAX_SNIPPET_LEN = 400;  // max chars per row (safety cap)

  const rows = highlights.map((h) => {
    const path = escapeHtml(h.path || "");
    const texts = Array.isArray(h.texts) ? h.texts : [];

    // Build snippet from ALL segments in texts[]
    const parts = texts.map((t) => {
      let v = escapeHtml(t.value || "");

      if (t.type === "hit") {
        // keep full hit and mark it
        return `<mark>${v}</mark>`;
      } else {
        // trim long non-hit segments so hits stay visible
        if (v.length > AROUND_LEN) {
          v = "…" + v.slice(v.length - AROUND_LEN);
        }
        return v;
      }
    });

    let snippet = parts.join("");

    return `
      <tr>
        <td>${path}</td>
        <td>${snippet}</td>
      </tr>
    `;
  }).join("");

  if (!rows) return "";

  return `
    <table class="subhl">
      <thead>
        <tr>
          <th>Field</th>
          <th>Snippet</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}


// Render HTML page with search form and results
module.exports = function registerSearchRoutes(app, db, bucket) {

  console.log("[search.js] registerSearchRoutes() called");

  function renderSearchPage(res, query = "", results = []) {
    const rows = results.map((file, i) => {
      const md = file.metadata || {};
      const sizeKB = ((file.length || 0) / 1024).toFixed(2);
      const dateStr = file.uploadDate ? new Date(file.uploadDate).toLocaleString() : "";
      const highlightSnippet = buildHighlightTable(file.highlights);

      return `
        <tr>
          <td>${i + 1}</td>
          <td>${escapeHtml(md.name || file.filename)}</td>
          <td>${escapeHtml(file.filename || "")}</td>
          <td>${escapeHtml(md.type || "")}</td>
          <td>${sizeKB} KB</td>
          <td>${escapeHtml(dateStr)}</td>
          <td>${escapeHtml(Array.isArray(md.keywords) ? md.keywords.join(", ") : (md.keywords || ""))}</td>
          <td>${escapeHtml(md.briefing || "")}</td>
          <td>${highlightSnippet}</td>
          <td>${file.score != null ? file.score.toFixed(2) : ""}</td>
          <td><a href="/search/download/${file._id}">Download</a></td>
        </tr>
      `;
    }).join("");

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title> Atlas Search (with Highlights)</title>
        <style>
          body { font-family: system-ui, sans-serif; margin: 20px; max-width: 1200px; }
          table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 0.9rem; }
          th, td { padding: 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
          th { background: #f5f5f5; }
          input { padding: 6px; font-size: 1rem; width: 320px; }
          button { padding: 6px 12px; margin-left: 8px; }
          mark { background: #ffe58f; padding: 0 2px; }
        </style>
      </head>
      <body>
        <h1>Search Files (Atlas Search + Highlights)</h1>

        <form method="GET" action="/search">
          <input type="text" name="q" value="${escapeHtml(query)}" placeholder="Search metadata, content..." required />
          <button type="submit">Search</button>
        </form>

        <h2>Results (${results.length})</h2>

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
              <th>Highlight</th>
              <th>Score</th>
              <th>Download</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </body>
      </html>
    `);
  }

  // -------------------------------
  // Search Route
  // -------------------------------
  app.get("/search", async (req, res) => {
    const q = req.query.q;
    console.log("[/search] called, q =", q);
    if (!q) return renderSearchPage(res);

    const pipeline = [
      {
        $search: {
          index: "default",
          compound: {
            should: [
              {
                autocomplete: {
                  query: q,
                  path: "metadata.name",
                  fuzzy: {
                    maxEdits: 1,
                    prefixLength: 2
                  }
                }
              },
              {
                text: {
                  query: q,
                  path: [
                    "metadata.keywords",
                    "metadata.type",
                    "metadata.sourcePath",
                    "metadata.content"
                  ],
                  score: { boost: { value: 2 } },
                  fuzzy: { maxEdits: 1, prefixLength: 2 }
                }
              },
              {
                text: {
                  query: q,
                  path: "metadata.briefing",
                  score: { boost: { value: 2 } },
                  fuzzy: { maxEdits: 1, prefixLength: 2 }
                }
              }
            ],
            minimumShouldMatch: 1
          },
          highlight: {
            path: [
              "metadata.name",
              "metadata.type",
              "metadata.keywords",
              "metadata.briefing",
              "metadata.sourcePath",
              "metadata.content"
            ]
          }
        }
      },
      { $limit: 50 },
      {
        $project: {
          _id: 1,
          filename: 1,
          uploadDate: 1,
          length: 1,
          metadata: 1,
          score: { $meta: "searchScore" },
          highlights: { $meta: "searchHighlights" }
        }
      }
    ]


    try {

      const results = await db.collection("abc_uploads.files")
        .aggregate(pipeline)
        .toArray();

      console.log("\n=== RAW SEARCH RESULTS ===");
      results.forEach((r, i) => {
        console.log(`Doc #${i + 1} _id=${r._id}`);
        console.log("  highlight count =", r.highlights?.length);
        console.log("  highlight paths =", r.highlights?.map(h => h.path));
      });
      console.log("=== END ===\n");

      renderSearchPage(res, q, results);

    } catch (err) {
      console.error("Search error:", err);
      res.status(500).send("Search error");
    }
  });

  // -------------------------------
  // Download Route for Search Page
  // -------------------------------
  app.get("/search/download/:id", async (req, res) => {
    try {
      const id = new ObjectId(req.params.id);

      const fileDoc = await db.collection("abc_uploads.files")
        .findOne({ _id: id });

      if (!fileDoc) return res.status(404).send("File not found");

      res.setHeader("Content-Type", fileDoc.contentType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${fileDoc.filename}"`);

      bucket.openDownloadStream(id).pipe(res);

    } catch (err) {
      console.error(err);
      res.status(500).send("Download error");
    }
  });

};

