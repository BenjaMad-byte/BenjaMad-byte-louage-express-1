import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stubSms, makeClock, postJson } from "./_helpers.js";

// Fichier séparé : le plafond quotidien est global, il ne doit pas gêner les autres tests.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-cap-"));
process.env.DATA_DIR = dataDir;
process.env.SMS_DAILY_CAP = "3";
const sms = stubSms();
const clock = makeClock();
let server, base, db;

before(async () => {
  const { createApp } = await import("../server.js");
  ({ db } = await import("../db.js"));
  server = createApp({ adminToken: "test-token-otp-1234", rateLimits: false, sms, now: clock.now }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("plafond quotidien global : au-delà, 503 sans envoyer de SMS ; il se libère après 24 h", async () => {
  for (const phone of ["55100001", "55100002", "55100003"]) {
    assert.equal((await postJson(base, "/api/otp/send", { phone })).status, 200);
  }
  const over = await postJson(base, "/api/otp/send", { phone: "55100004" });
  assert.equal(over.status, 503);
  assert.equal((await over.json()).error, "sms_unavailable");
  assert.equal(sms.sent.length, 3);

  clock.advance(24 * 3_600_000 + 1000);
  assert.equal((await postJson(base, "/api/otp/send", { phone: "55100004" })).status, 200);
});
