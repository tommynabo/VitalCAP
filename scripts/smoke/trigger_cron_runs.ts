export {};
async function main() {
  console.log("Triggering /api/cron/provider-runs...");
  try {
    const res = await fetch("https://vitalcapproject.vercel.app/api/cron/provider-runs", {
      headers: { Authorization: "Bearer 83e8f87897a1939da5682af02cd0b2686267163226ebe003610c8c745bbcc244" }
    });
    console.log("Status:", res.status, res.statusText);
    const text = await res.text();
    console.log("Response:", text);
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
main();
