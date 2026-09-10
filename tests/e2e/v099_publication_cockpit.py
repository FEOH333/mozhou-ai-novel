"""V0.99 真实浏览器冒烟：推流驾驶舱、质量曲线、发布确认与窄屏布局。"""
from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    base_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18791"
    errors: list[str] = []
    desktop_shot = Path(tempfile.gettempdir()) / "novel-v099-publication-desktop.png"
    mobile_shot = Path(tempfile.gettempdir()) / "novel-v099-publication-mobile.png"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
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
            modal.locator("textarea:visible").first.fill("乱世少年从庙会逃生，在四十年山河变局中学会保护身边人。")
            modal.get_by_role("button", name="创建作品").click()
            page.wait_for_url(re.compile(r"#/book/[^/]+/workshop"), wait_until="networkidle")
            book_id = re.search(r"#/book/([^/]+)/workshop", page.url).group(1)

            page.locator("#pilot-target").fill("7")
            page.locator("#pilot-polish").uncheck()
            page.locator("#pilot-btn").click()
            page.wait_for_function(
                """async (id) => {
                  const response = await fetch(`/api/books/${id}`);
                  if (!response.ok) return false;
                  const book = await response.json();
                  return book.chapters?.length >= 7
                    && book.chapters.slice(0, 7).every(ch => ['done', 'settled', 'revised'].includes(ch.status));
                }""",
                arg=book_id,
                timeout=120_000,
            )
            page.wait_for_function(
                """() => document.querySelector('#pilot-btn') && !document.querySelector('#pilot-btn').disabled""",
                timeout=120_000,
            )
            seeded_book = page.request.get(f"{base_url}/api/books/{book_id}").json()
            for chapter in seeded_book["chapters"][:7]:
                details = page.request.get(f"{base_url}/api/books/{book_id}/chapters/{chapter['id']}").json()
                for scene in details.get("scenes", []):
                    response = page.request.patch(
                        f"{base_url}/api/books/{book_id}/scenes/{scene['id']}",
                        data={"targetWords": 200},
                    )
                    assert response.ok, response.text()

            profile_response = page.request.put(
                f"{base_url}/api/books/{book_id}/publication",
                data={
                    "recommendationStage": "failed",
                    "remainingAttempts": 2,
                    "editorFeedback": "当前内容未达推荐标准，前20章整体不合格",
                    "authorDiagnosis": "前1—6章或勉强可用，第7章以后越来越水",
                    "suspectedTurnChapter": 7,
                    "publishedChapterCount": 7,
                    "publishedWordCount": 28000,
                },
            )
            assert profile_response.ok, profile_response.text()
            metric_response = page.request.post(
                f"{base_url}/api/books/{book_id}/publication/metrics",
                data={"exposureStatus": "not_exposed", "readers": 0, "impressions": 0, "note": "推流前"},
            )
            assert metric_response.ok, metric_response.text()

            page.reload(wait_until="networkidle")
            cockpit = page.locator(".publication-cockpit")
            cockpit.wait_for(state="visible")
            assert cockpit.get_by_text("P0 内容质量事故", exact=False).is_visible()
            assert cockpit.get_by_text("第 1—6 章 · 疑似基线", exact=True).is_visible()
            assert cockpit.get_by_text(re.compile(r"第 7—\d+ 章 · 高风险严审")).is_visible()
            cockpit.get_by_text("03 · 记录作品数据（按观察窗口追加）", exact=True).click()
            assert cockpit.get_by_text(re.compile(r"未获曝光时，0 读者是正常")).is_visible()
            cockpit.screenshot(path=str(desktop_shot))

            # 单按钮一键流程：诊断完成后自动弹出执行确认，无需再点第二个按钮
            cockpit.get_by_role("button", name=re.compile(r"一键诊断并返工|一键返工")).click()
            confirmation = page.locator(".modal").last
            confirmation.get_by_text("明确确认返工已发布正文？", exact=True).wait_for(state="visible", timeout=60_000)
            assert confirmation.get_by_text(re.compile(r"待线上同步")).is_visible()
            confirmation.get_by_role("button", name="确定").click()

            page.wait_for_function(
                """async (id) => {
                  const response = await fetch(`/api/books/${id}/publication`, {cache: 'no-store'});
                  const data = await response.json();
                  return data.recoveryRuns?.[0]?.status === 'completed'
                    && data.profile?.pending_sync_chapters?.includes(7);
                }""",
                arg=book_id,
                timeout=60_000,
            )
            page.reload(wait_until="networkidle")
            page.get_by_text("05 · 待线上同步", exact=True).wait_for(state="visible")
            assert page.get_by_text(re.compile(r"第7章")).last.is_visible()

            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(300)
            overflow = page.evaluate(
                """() => ({
                  viewport: window.innerWidth,
                  scrollWidth: document.documentElement.scrollWidth,
                  offenders: [...document.querySelectorAll('body *')]
                    .map(el => {
                      const rect = el.getBoundingClientRect();
                      return {
                        tag: el.tagName.toLowerCase(),
                        id: el.id,
                        cls: typeof el.className === 'string' ? el.className : '',
                        left: Math.round(rect.left),
                        right: Math.round(rect.right),
                        width: Math.round(rect.width),
                        scrollWidth: el.scrollWidth,
                      };
                    })
                    .filter(item => item.right > window.innerWidth + 1 || item.left < -1)
                    .sort((a, b) => b.right - a.right)
                    .slice(0, 12),
                })"""
            )
            assert overflow["scrollWidth"] <= overflow["viewport"] + 1, f"窄屏出现整页横向溢出: {overflow}"
            cockpit.scroll_into_view_if_needed()
            page.wait_for_timeout(200)
            cockpit_box = cockpit.bounding_box()
            assert cockpit_box is not None and cockpit_box["width"] <= 390, f"驾驶舱超出窄屏: {cockpit_box}"
            assert cockpit.get_by_text("推流质量驾驶舱", exact=True).is_visible()
            page.screenshot(path=str(mobile_shot), full_page=True)
            assert not errors, "；".join(errors)
            print(f"E2E_V099_OK book={book_id}")
            print(f"E2E_DESKTOP_SCREENSHOT={desktop_shot}")
            print(f"E2E_MOBILE_SCREENSHOT={mobile_shot}")
        except Exception:
            failure = Path(tempfile.gettempdir()) / "novel-v099-publication-failure.png"
            page.screenshot(path=str(failure), full_page=True)
            print(f"E2E_SCREENSHOT={failure}", file=sys.stderr)
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main()
