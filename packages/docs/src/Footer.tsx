import "./Footer.css";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="badge-row" aria-label="Project badges">
        <a href="https://www.npmjs.com/package/autoremediator" target="_blank" rel="noreferrer">
          <img
            src="https://img.shields.io/npm/v/autoremediator.svg"
            alt="npm version badge"
            loading="lazy"
          />
        </a>
        <a href="https://github.com/Rawlings/autoremediator" target="_blank" rel="noreferrer">
          <img
            src="https://img.shields.io/github/stars/Rawlings/autoremediator.svg?style=social"
            alt="GitHub stars badge"
            loading="lazy"
          />
        </a>
      </div>

      <div className="external-links" aria-label="Package and repository links">
        <a href="https://www.npmjs.com/package/autoremediator" target="_blank" rel="noreferrer">
          npm package
        </a>
        <a href="https://github.com/Rawlings/autoremediator" target="_blank" rel="noreferrer">
          GitHub repository
        </a>
        <a className="site-link" href="https://rawlings.github.io/autoremediator/" target="_blank" rel="noreferrer">
          Open site
        </a>
      </div>
    </footer>
  );
}
