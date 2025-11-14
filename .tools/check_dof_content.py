import csv
import asyncio
from playwright.async_api import async_playwright

INPUT_FILE = "data/arter_filter_klassificeret.csv"
OUTPUT_FILE = "data/arter_dof_content.csv"

async def main():
    # Læs eksisterende artsid'er
    checked_ids = set()
    try:
        with open(OUTPUT_FILE, encoding="utf-8") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                checked_ids.add(row["artsid"])
    except FileNotFoundError:
        pass

    # Læs alle rækker for at tælle total og for progress
    with open(INPUT_FILE, encoding="utf-8") as infile:
        all_rows = list(csv.DictReader(infile, delimiter=";"))
    total = len(all_rows)
    to_check = [row for row in all_rows if row["artsid"].zfill(5) not in checked_ids]
    remaining = len(to_check)
    print(f"Starter: {remaining} af {total} mangler...")

    # Åbn outputfil i append-mode
    with open(INPUT_FILE, encoding="utf-8") as infile, open(OUTPUT_FILE, "a", newline="", encoding="utf-8") as outfile:
        reader = csv.DictReader(infile, delimiter=";")
        writer = csv.writer(outfile, delimiter=";")
        # Skriv header kun hvis filen er tom
        if outfile.tell() == 0:
            writer.writerow(["artsid", "artsnavn", "content"])
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            done = total - remaining
            for idx, row in enumerate(reader):
                artsid = row["artsid"].zfill(5)
                if artsid in checked_ids:
                    continue
                artsnavn = row["artsnavn"]
                url = f"https://dofbasen.dk/danmarksfugle/art/{artsid}"
                try:
                    await page.goto(url, timeout=20000)
                    await page.wait_for_selector("h1, .container, .row", timeout=5000)
                    content_text = await page.inner_text("#app")
                    content = 1 if content_text.strip() else 0
                except Exception:
                    content = 0
                writer.writerow([artsid, artsnavn, content])
                outfile.flush()
                done += 1
                print(f"[{done}/{total}] {artsid} - {artsnavn} - content: {content}")
                await asyncio.sleep(0.5)  # max 2 requests/sek
            await browser.close()

if __name__ == "__main__":
    asyncio.run(main())