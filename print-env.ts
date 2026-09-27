import fs from "node:fs";
const urls = Object.keys(process.env).filter(k => k.includes("URL")).map(k => `${k}=${process.env[k]}`).join("\n");
fs.writeFileSync("db_all_urls.txt", urls || "NO URLS FOUND");
