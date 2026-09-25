import assert from "node:assert/strict";
import test from "node:test";
import {
  downloadMarkdownFile,
  downloadReport,
  generateReportFilename,
  getReportMarkdown,
  isReportDownloadable,
  sanitizeReportMarkdown,
  slugify,
  stripFilesystemPaths,
} from "../public/report-download.js";

test("generateReportFilename produces safe and readable Markdown filenames", () => {
  assert.equal(generateReportFilename(), "report.md");
  assert.equal(generateReportFilename(""), "report.md");
  assert.equal(generateReportFilename({}), "report.md");

  assert.equal(
    generateReportFilename({ query: "emerging AI creators", platform: "instagram" }),
    "report-instagram-emerging-ai-creators.md",
  );
  assert.equal(
    generateReportFilename({ query: "wearable devices", platform: "tiktok" }),
    "report-tiktok-wearable-devices.md",
  );
  assert.equal(
    generateReportFilename({ query: "AI product managers", platform: "linkedin" }),
    "report-linkedin-ai-product-managers.md",
  );

  // Platform "auto" is omitted from the filename prefix
  assert.equal(
    generateReportFilename({ query: "find robotics startups", platform: "auto" }),
    "report-find-robotics-startups.md",
  );

  // Platform only (no query or empty query)
  assert.equal(
    generateReportFilename({ platform: "instagram" }),
    "report-instagram.md",
  );

  // Avoid duplicating platform if the query already starts with it
  assert.equal(
    generateReportFilename({ query: "tiktok viral dances", platform: "tiktok" }),
    "report-tiktok-viral-dances.md",
  );
  assert.equal(
    generateReportFilename({ query: "tiktok", platform: "tiktok" }),
    "report-tiktok.md",
  );

  // Unicode support
  assert.equal(
    generateReportFilename({ query: "寻找人工智能创作者", platform: "tiktok" }),
    "report-tiktok-寻找人工智能创作者.md",
  );

  // Strips directory traversals and unsafe path separators
  assert.equal(
    generateReportFilename({ query: "../../etc/passwd", platform: "instagram" }),
    "report-instagram-etc-passwd.md",
  );
  assert.equal(
    generateReportFilename({ query: "C:\\Windows\\System32\\cmd.exe", platform: "linkedin" }),
    "report-linkedin-cmd-exe.md",
  );
  assert.equal(
    generateReportFilename({ query: "test<foo>:bar*baz?qux\"one|two" }),
    "report-test-foo-bar-baz-qux-one-two.md",
  );

  // Long queries are truncated cleanly without trailing hyphens
  const longQuery = "a-very-long-search-query-that-exceeds-the-maximum-allowed-slug-length-for-file-naming";
  const filename = generateReportFilename({ query: longQuery, platform: "tiktok" });
  assert.ok(filename.length < 80);
  assert.match(filename, /^report-tiktok-[a-z0-9-]+[a-z0-9]\.md$/);
  assert.ok(!filename.includes("--"));
});

test("stripFilesystemPaths removes local path indicators and drive letters", () => {
  assert.equal(stripFilesystemPaths("file:///Users/demo/report.json"), "report.json");
  assert.equal(stripFilesystemPaths("C:\\Users\\demo\\report.json"), "report.json");
  assert.equal(stripFilesystemPaths("D:/projects/jev-social/data.txt"), "data.txt");
  assert.equal(stripFilesystemPaths("/tmp/private/run_123"), "run_123");
  assert.equal(stripFilesystemPaths("/Users/alice/Library/notes.md"), "notes.md");
  assert.equal(stripFilesystemPaths("../../sensitive/file"), "sensitive file");
  assert.equal(stripFilesystemPaths("normal search terms"), "normal search terms");
});

test("slugify creates normalized hyphen-separated slugs preserving Unicode characters", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.equal(slugify("  multiple   spaces  and---hyphens "), "multiple-spaces-and-hyphens");
  assert.equal(slugify("Café & Croissant"), "cafe-croissant");
  assert.equal(slugify("人工智能 2026"), "人工智能-2026");
  assert.equal(slugify(""), "");
});

test("sanitizeReportMarkdown redacts local filesystem paths and preserves valid markdown/URLs", () => {
  const input = [
    "# Captured evidence",
    "",
    "Request: Emerging creators",
    "",
    "[Source](https://www.instagram.com/p/abc/)",
    "",
    "Execution info: run_dir: /tmp/private/run-987",
    "Evidence stored at local_path: /Users/alice/Library/Caches/jev/media.mp4",
    "Windows path: C:\\Users\\Barshan\\AppData\\Local\\Temp\\socai\\run.log",
    "File URI: file:///tmp/scratch/debug.txt",
    "Home path: ~/private/run.json",
    "Relative path: ../private/run.json",
    "Workspace path: /workspace/private/run.json",
    "Single path: /secret",
    "Spaced path: /Users/alice/My Project/private.txt",
    "Bare relative path: private/run.json",
    "Assigned path: model=/private",
    "UNC path: \\\\server\\share\\run.json",
    "Relative assignment: artifact_path=relative.json",
    "",
    "Normal text and https://tiktok.com/@creator/video/123 remain intact.",
  ].join("\n");

  const sanitized = sanitizeReportMarkdown(input);

  // Markdown structure and HTTP URLs must be preserved
  assert.match(sanitized, /# Captured evidence/);
  assert.match(sanitized, /\[Source\]\(https:\/\/www\.instagram\.com\/p\/abc\/\)/);
  assert.match(sanitized, /https:\/\/tiktok\.com\/@creator\/video\/123/);

  // Local filesystem paths must be redacted
  assert.ok(!sanitized.includes("/tmp/private/run-987"));
  assert.ok(!sanitized.includes("/Users/alice/Library/Caches"));
  assert.ok(!sanitized.includes("C:\\Users\\Barshan"));
  assert.ok(!sanitized.includes("file:///tmp/scratch"));
  assert.ok(!sanitized.includes("~/private/run.json"));
  assert.ok(!sanitized.includes("../private/run.json"));
  assert.ok(!sanitized.includes("/workspace/private/run.json"));
  assert.ok(!sanitized.includes("/secret"));
  assert.ok(!sanitized.includes("/Users/alice/My Project/private.txt"));
  assert.ok(!sanitized.includes("private/run.json"));
  assert.ok(!sanitized.includes("model=/private"));
  assert.ok(!sanitized.includes("\\\\server\\share\\run.json"));
  assert.ok(!sanitized.includes("artifact_path=relative.json"));
  assert.match(sanitized, /run_dir:\s*\[redacted path\]/);
  assert.match(sanitized, /local_path:\s*\[redacted path\]/);
  assert.match(sanitized, /\[redacted path\]/);
});

test("sanitizeReportMarkdown rejects raw run JSON dumps without a report", () => {
  const rawRunJson = JSON.stringify({
    id: "run-12345",
    status: "completed",
    actions: [{ command: "socai instagram search" }],
    result: { items: [] },
  });

  // A raw run object with no report string must NOT be dumped to the file
  assert.equal(sanitizeReportMarkdown(rawRunJson), "");

  // If a JSON string with an embedded report is passed, only the report is extracted
  const jsonWithReport = JSON.stringify({
    id: "run-12345",
    report: "# Evidence report\nFound 5 creators.",
  });
  assert.equal(sanitizeReportMarkdown(jsonWithReport), "# Evidence report\nFound 5 creators.");
});

test("getReportMarkdown and isReportDownloadable accurately detect downloadable reports", () => {
  assert.equal(isReportDownloadable(null), false);
  assert.equal(isReportDownloadable(undefined), false);
  assert.equal(isReportDownloadable(""), false);
  assert.equal(isReportDownloadable("   "), false);
  assert.equal(isReportDownloadable("socai completed without a report."), false);
  assert.equal(isReportDownloadable({}), false);
  assert.equal(isReportDownloadable({ status: "failed" }), false);
  assert.equal(isReportDownloadable({ report: "" }), false);
  assert.equal(isReportDownloadable({ report: "   " }), false);
  assert.equal(isReportDownloadable({ report: "socai completed without a report." }), false);

  const validRun = {
    request: "AI creators",
    platform: "tiktok",
    report: "# Captured evidence\n\nRequest: AI creators\n- Item 1",
  };
  assert.equal(isReportDownloadable(validRun), true);
  assert.equal(getReportMarkdown(validRun), "# Captured evidence\n\nRequest: AI creators\n- Item 1");

  // Fallback to finalSocaiOutput if report field is absent
  const outputRun = {
    request: "AI creators",
    finalSocaiOutput: "# From output\nFound evidence.",
  };
  assert.equal(isReportDownloadable(outputRun), true);
  assert.equal(getReportMarkdown(outputRun), "# From output\nFound evidence.");
});

test("downloadReport returns structured metadata in headless environments without errors", () => {
  // Empty / unavailable report
  const emptyResult = downloadReport({ report: "" });
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.error, /No non-empty report/);

  // Valid report with run object
  const run = {
    query: "wearable AI",
    platform: "tiktok",
    report: "# Evidence\nTikTok results.\nlocal_path: /tmp/secret.mp4",
  };
  const result = downloadReport({ run });
  assert.equal(result.ok, true);
  assert.equal(result.filename, "report-tiktok-wearable-ai.md");
  assert.equal(result.clientSide, false);
  assert.match(result.content, /# Evidence/);
  assert.ok(!result.content.includes("/tmp/secret.mp4"));
  assert.match(result.content, /\[redacted path\]/);
});

test("downloadMarkdownFile interacts with DOM and Blob APIs when present", () => {
  let createdBlobContent = null;
  let createdBlobType = null;
  class MockBlob {
    constructor(parts, options) {
      createdBlobContent = parts.join("");
      createdBlobType = options?.type;
      this.size = Buffer.byteLength(createdBlobContent, "utf8");
    }
  }

  let createdUrl = null;
  let revokedUrl = null;
  const mockURL = {
    createObjectURL(blob) {
      createdUrl = `blob:http://127.0.0.1/${Math.random()}`;
      return createdUrl;
    },
    revokeObjectURL(url) {
      revokedUrl = url;
    },
  };

  let appendedChild = null;
  let clicked = false;
  let removed = false;
  const mockAnchor = {
    href: "",
    download: "",
    style: {},
    click() {
      clicked = true;
    },
    remove() {
      removed = true;
    },
  };

  const mockDocument = {
    createElement(tag) {
      assert.equal(tag, "a");
      return mockAnchor;
    },
    body: {
      append(element) {
        appendedChild = element;
      },
    },
  };

  const result = downloadMarkdownFile("test-report.md", "# Findings\n- Item", {
    document: mockDocument,
    Blob: MockBlob,
    URL: mockURL,
  });

  assert.equal(result.ok, true);
  assert.equal(result.clientSide, true);
  assert.equal(result.filename, "test-report.md");
  assert.equal(createdBlobContent, "# Findings\n- Item");
  assert.equal(createdBlobType, "text/markdown;charset=utf-8");
  assert.equal(mockAnchor.download, "test-report.md");
  assert.equal(mockAnchor.href, createdUrl);
  assert.equal(mockAnchor.hidden, true);
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.equal(appendedChild, mockAnchor);
});
