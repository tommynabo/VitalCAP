async function main() {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("CRON_SECRET is required to trigger protected cron endpoints.");
    process.exitCode = 1;
    return;
  }
  console.log("Triggering /api/cron/discovery...");
  try {
    const res = await fetch("https://vitalcapproject.vercel.app/api/cron/discovery", {
      headers: { Authorization: "Bearer " + cronSecret }
    });
    console.log("Status:", res.status, res.statusText);
    const text = await res.text();
    console.log("Response:", text);
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
main();
