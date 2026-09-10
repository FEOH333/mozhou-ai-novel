"""真实浏览器冒烟：空书的一键自动创作主路径。不会调用真实 LLM。"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18779"
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: errors.append(f"console.{message.type}: {message.text}")
            if message.type == "error"
            else None,
        )
        try:
            page.goto(base_url, wait_until="networkidle")
            page.get_by_role("button", name="新建作品").click()
            modal = page.locator(".modal").last
            modal.locator("textarea:visible").first.fill("一个落魄少年把废料炼成灵气，在宗门里步步升级并守住朋友。")
            modal.get_by_role("button", name="创建作品").click()
            page.wait_for_url(re.compile(r"#/book/[^/]+/workshop"), wait_until="networkidle")

            match = re.search(r"#/book/([^/]+)/workshop", page.url)
            assert match, f"无法从 URL 取得 book id: {page.url}"
            book_id = match.group(1)
            before = page.request.get(f"{base_url}/api/books/{book_id}").json()
            assert before.get("chapters") == [], "新建书应从零章节开始，才能覆盖空书启动回归"

            start = page.locator("#pilot-btn")
            assert start.is_visible(), "空书写作台必须显示“开始自动创作”"
            page.locator("#pilot-target").fill("1")
            page.locator("#pilot-polish").uncheck()
            start.click()

            page.wait_for_function(
                """async (id) => {
                  const response = await fetch(`/api/books/${id}`);
                  if (!response.ok) return false;
                  const book = await response.json();
                  return Array.isArray(book.chapters)
                    && book.chapters.some(ch => ['done', 'settled'].includes(ch.status));
                }""",
                arg=book_id,
                timeout=90_000,
            )
            page.wait_for_function(
                """() => {
                  const button = document.querySelector('#pilot-btn');
                  return button && !button.disabled;
                }""",
                timeout=90_000,
            )
            page.wait_for_load_state("networkidle")
            after = page.request.get(f"{base_url}/api/books/{book_id}").json()
            assert len(after.get("chapters", [])) >= 1
            assert any(ch.get("status") in {"done", "settled"} for ch in after["chapters"])

            page.locator(".brand").click()
            page.wait_for_url(re.compile(r"#/?$|#/library"), wait_until="networkidle")
            page.locator(".book-card").wait_for(state="visible")
            assert page.locator(".book-card").count() == 1
            assert not errors, "；".join(errors)
            print(f"E2E_OK book={book_id} chapters={len(after['chapters'])}")
        except Exception:
            screenshot = Path.home() / "AppData" / "Local" / "Temp" / "novel-v077-e2e-failure.png"
            page.screenshot(path=str(screenshot), full_page=True)
            print(f"E2E_SCREENSHOT={screenshot}", file=sys.stderr)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
