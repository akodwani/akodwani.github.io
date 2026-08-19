(() => {
  const sectionId = "drca-process-tree-embed";

  function mountTree() {
    const firstProject = document.querySelector(".drca-video-grid .drca-video-block");
    if (!firstProject || document.getElementById(sectionId)) return;

    const section = document.createElement("section");
    section.id = sectionId;
    section.setAttribute("aria-label", "D.R.C.A model process trees");
    section.style.cssText = [
      "position:relative",
      "z-index:4",
      "width:100%",
      "margin:clamp(90px,16vh,200px) 0 0",
      "overflow:hidden",
    ].join(";");

    const frame = document.createElement("iframe");
    frame.src = "/drca-process-node-tree.html";
    frame.title = "D.R.C.A model process trees";
    frame.loading = "lazy";
    frame.scrolling = "no";
    frame.style.cssText = [
      "display:block",
      "width:100%",
      "height:720px",
      "min-height:720px",
      "border:0",
      "background:#181818",
    ].join(";");

    const resizeFrame = () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const height = Math.max(
        doc.documentElement?.scrollHeight || 0,
        doc.body?.scrollHeight || 0,
        720,
      );
      frame.style.height = `${height}px`;
    };

    frame.addEventListener("load", () => {
      resizeFrame();
      const doc = frame.contentDocument;
      if (!doc || !("ResizeObserver" in window)) return;
      const observer = new ResizeObserver(resizeFrame);
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
    });

    window.addEventListener("resize", resizeFrame, { passive: true });
    section.append(frame);
    firstProject.append(section);
  }

  const observer = new MutationObserver(mountTree);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountTree, { once: true });
  } else {
    mountTree();
  }
  window.addEventListener("load", () => window.setTimeout(mountTree, 250), { once: true });
})();
