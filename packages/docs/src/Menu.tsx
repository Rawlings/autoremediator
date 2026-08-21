import { useState } from "react";
import { NavLink } from "react-router-dom";
import { docs } from "./DocPage";
import { TocPanel } from "./TocPanel";
import "./Menu.css";

export function Menu() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <>
      <button
        className={open ? "menu-toggle open" : "menu-toggle"}
        onClick={() => setOpen((o) => !o)}
        aria-label="Toggle menu"
        aria-expanded={open}
      >
        <span />
        <span />
        <span />
      </button>

      {open && <div className="menu-backdrop" onClick={close} />}

      <aside className={open ? "side-menu open" : "side-menu"}>
        <div className="side-menu-primary">
          <nav className="side-nav" aria-label="Reference sections" onClick={close}>
            <NavLink
              to="/"
              end
              className={({ isActive }) => (isActive ? "menu-item active" : "menu-item")}
            >
              Home
            </NavLink>
            {docs.map((doc) => (
              <NavLink
                key={doc.slug}
                to={`/docs/${doc.slug}`}
                className={({ isActive }) => (isActive ? "menu-item active" : "menu-item")}
              >
                {doc.title}
              </NavLink>
            ))}
          </nav>

          <div className="menu-footer">
            <a href="https://www.npmjs.com/package/autoremediator" target="_blank" rel="noreferrer">
              npm
            </a>
            <a href="https://github.com/Rawlings/autoremediator" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </div>

          <div className="menu-logo">
            <img src="/favicon.svg" alt="" className="menu-logo-img" />
            <span className="menu-logo-wordmark">autoremediator</span>
          </div>
        </div>

        <div className="side-submenu">
          <TocPanel />
        </div>
      </aside>
    </>
  );
}
