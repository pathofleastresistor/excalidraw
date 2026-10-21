import { toWebMCPTool } from "./common";
import { ALL_TOOLS } from "./tools";

import type App from "../components/App";
import type { WebMCPModelContext, WebMCPOptions } from "./types";

type ModelContextHost = Document & { modelContext?: WebMCPModelContext };

/**
 * The editor's WebMCP integration: exposes the canvas to in-browser agents as
 * tools (see `./tools`), through `document.modelContext`. Where the browser
 * has no WebMCP it does nothing.
 *
 * Tools are registered while `props.webMCP` is set and the editor is
 * mounted, and withdrawn when either stops being true.
 */
export class AppWebMCP {
  private registration: { controller: AbortController; key: string } | null =
    null;

  constructor(private app: App) {}

  /** whether the browser can expose tools at all */
  static isSupported(document: Document) {
    return !!(document as ModelContextHost).modelContext?.registerTool;
  }

  private getOptions(): WebMCPOptions | null {
    const { webMCP } = this.app.props;
    if (!webMCP) {
      return null;
    }
    return webMCP === true ? {} : webMCP;
  }

  /** (un)registers the tools to match the current props */
  sync = () => {
    const options = this.getOptions();
    const key = JSON.stringify(options);
    if (this.registration && (!options || this.registration.key !== key)) {
      this.unregister();
    }
    if (options && !this.registration) {
      this.register(options, key);
    }
  };

  private register(options: WebMCPOptions, key: string) {
    const { ownerDocument } = this.app;
    const modelContext = (ownerDocument as ModelContextHost).modelContext;
    if (!modelContext?.registerTool) {
      return;
    }

    const controller = new AbortController();
    this.registration = { controller, key };

    const tools = ALL_TOOLS.filter(
      (tool) => !options.readOnly || tool.annotations.readOnlyHint,
    );
    for (const definition of tools) {
      const tool = toWebMCPTool(definition, this.getLiveApp);
      // a document has one set of tools: with several editors on a page the
      // first one to register keeps the names, and the others are left out
      Promise.resolve(
        modelContext.registerTool(tool, {
          signal: controller.signal,
          ...(options.exposedTo ? { exposedTo: options.exposedTo } : {}),
        }),
      ).catch((error) => {
        if (!controller.signal.aborted) {
          console.warn(
            `[Excalidraw] couldn't register the WebMCP tool "${tool.name}"`,
            error,
          );
        }
      });
    }
  }

  private unregister() {
    this.registration?.controller.abort();
    this.registration = null;
  }

  private getLiveApp = () => (this.app.api.isDestroyed ? null : this.app);

  destroy() {
    this.unregister();
  }
}
