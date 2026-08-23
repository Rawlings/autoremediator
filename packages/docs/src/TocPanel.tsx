import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import "./TocPanel.css";

interface TocItem {
  id: string;
  text: string;
  level: number;
  children: TocItem[];
}

export function TocPanel() {
  const { pathname } = useLocation();
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    // Extract headings from the rendered markdown article
    const headingElements = Array.from(
      document.querySelectorAll<HTMLHeadingElement>(
        ".markdown-rendered h1, .markdown-rendered h2, .markdown-rendered h3",
      ),
    ).filter((el) => Boolean(el.id));

    const rootItems: TocItem[] = [];
    let currentH2: TocItem | null = null;

    for (const el of headingElements) {
      const level = parseInt(el.tagName.substring(1), 10);
      const text = el.textContent?.trim() ?? "";
      const item: TocItem = { id: el.id, text, level, children: [] };

      if (level <= 2) {
        rootItems.push(item);
        currentH2 = item;
      } else if (level === 3) {
        if (currentH2) {
          currentH2.children.push(item);
        } else {
          rootItems.push(item);
        }
      }
    }

    setItems(rootItems);
    if (rootItems.length > 0) {
      setActiveId(rootItems[0].id);
    }

    if (headingElements.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
            break;
          }
        }
      },
      {
        rootMargin: "0px 0px -65% 0px",
        threshold: 0,
      },
    );

    for (const el of headingElements) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
    };
  }, [pathname]);

  if (items.length === 0) {
    return null;
  }

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", `#${id}`);
      setActiveId(id);
    }
  };

  return (
    <aside className="toc-panel" aria-label="Table of contents">
      <nav className="toc-nav">
        <ul className="toc-list">
          {items.map((item) => {
            const isActive = activeId === item.id;
            return (
              <li key={item.id} className="toc-list-item">
                <a
                  href={`#${item.id}`}
                  className={`toc-link ${isActive ? "is-active-link" : ""}`}
                  onClick={(e) => handleLinkClick(e, item.id)}
                >
                  {item.text}
                </a>
                {item.children.length > 0 && (
                  <ul className="toc-list">
                    {item.children.map((child) => {
                      const isChildActive = activeId === child.id;
                      return (
                        <li key={child.id} className="toc-list-item">
                          <a
                            href={`#${child.id}`}
                            className={`toc-link ${isChildActive ? "is-active-link" : ""}`}
                            onClick={(e) => handleLinkClick(e, child.id)}
                          >
                            {child.text}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
