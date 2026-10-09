import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { readGuideSession, type GuideSession } from "./cuelightApp";
import { RuntimeProvider, router } from "./routes";
import "./styles.css";

let session: GuideSession | undefined;
let linkError: string | undefined;
try {
  session = readGuideSession(window.location, window.history);
} catch (error) {
  linkError = error instanceof Error ? error.message : "This guide link is invalid.";
}

createRoot(document.getElementById("root")!).render(<StrictMode><RuntimeProvider session={session} linkError={linkError}><RouterProvider router={router} /></RuntimeProvider></StrictMode>);
