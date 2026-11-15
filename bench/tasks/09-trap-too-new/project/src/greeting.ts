import { render } from "bench-tmpl";

export const greeting = (name: string): string => render("Hello, {{name}}!", { name });
