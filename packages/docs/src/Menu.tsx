import { NavLink } from "react-router-dom";
import { docs } from "./DocPage";
import "./Menu.css";

export function Menu() {
  return (
    <aside className="side-menu">
      <div className="menu-brand">
        <p className="menu-eyebrow">Autoremediator</p>
        <h1 className="menu-title">Security Reference</h1>
        <p className="menu-subtitle">Automation-first guidance, references, and integration patterns</p>
      </div>

      <nav className="side-nav" aria-label="Reference sections">
        <NavLink to="/" end className={({ isActive }) => (isActive ? "menu-item active" : "menu-item")}>
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
    </aside>
  );
}
