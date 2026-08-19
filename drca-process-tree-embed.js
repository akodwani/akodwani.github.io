(() => {
  const explanationId = "drca-project-explanation";
  const sectionId = "drca-process-tree-embed";

  function mountExplanation() {
    const intro = document.querySelector(".drca-intro");
    const videoGrid = document.querySelector(".drca-video-grid");
    if (!intro || !videoGrid || document.getElementById(explanationId)) return;

    if (!document.getElementById("drca-project-explanation-styles")) {
      const styles = document.createElement("style");
      styles.id = "drca-project-explanation-styles";
      styles.textContent = `
        #${explanationId} {
          position: relative;
          z-index: 4;
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr);
          gap: clamp(48px, 8vw, 140px);
          margin: 0 max(28px, 7vw) 16vh;
          padding: clamp(34px, 5vw, 76px) 0;
          border-top: 1px solid #252525;
          border-bottom: 1px solid #252525;
          color: #ececec;
        }
        #${explanationId} .drca-project-caption {
          margin: 0 0 22px;
          color: #777;
          font: 10px/1.2 monospace;
          text-transform: uppercase;
        }
        #${explanationId} h2 {
          max-width: 780px;
          margin: 0;
          color: #ececec;
          font: clamp(38px, 5vw, 76px)/.9 "Times New Roman", serif;
          letter-spacing: -.045em;
        }
        #${explanationId} .drca-project-lede > p:last-child {
          max-width: 680px;
          margin: 30px 0 0;
          color: #aaa;
          font: 15px/1.55 Arial, sans-serif;
        }
        #${explanationId} dl { display: grid; align-content: start; margin: 0; }
        #${explanationId} dl div {
          display: grid;
          grid-template-columns: minmax(90px, .34fr) minmax(0, 1fr);
          gap: 24px;
          padding: 18px 0;
          border-top: 1px solid #252525;
        }
        #${explanationId} dl div:first-child { padding-top: 0; border-top: 0; }
        #${explanationId} dt, #${explanationId} dd { margin: 0; }
        #${explanationId} dt {
          color: #777;
          font: 10px/1.4 monospace;
          text-transform: uppercase;
        }
        #${explanationId} dd { color: #d7d7d7; font: 13px/1.5 Arial, sans-serif; }
        @media (max-width: 700px) {
          #${explanationId} {
            display: block;
            width: calc(100% - 36px);
            max-width: calc(100vw - 36px);
            margin: 0 18px 12vh;
            padding: 28px 0;
            overflow: hidden;
          }
          #${explanationId} h2 {
            max-width: 100%;
            font-size: clamp(34px, 10vw, 42px);
            white-space: normal;
            overflow-wrap: break-word;
          }
          #${explanationId} .drca-project-lede > p:last-child { margin-top: 24px; font-size: 14px; }
          #${explanationId} dl { margin-top: 48px; }
          #${explanationId} dl div { grid-template-columns: 92px minmax(0, 1fr); gap: 18px; }
          #${explanationId} dd { min-width: 0; overflow-wrap: anywhere; }
        }
      `;
      document.head.append(styles);
    }

    const section = document.createElement("section");
    section.id = explanationId;
    section.setAttribute("aria-label", "D.R.C.A project ownership and tools");
    section.innerHTML = `
      <div class="drca-project-lede">
        <p class="drca-project-caption">Project ownership</p>
        <h2>A self-directed fashion world built from concept to campaign.</h2>
        <p>D.R.C.A. is a speculative project rather than a physically produced collection. I created the concept, visual system, campaign direction, generated assets, and final edit as one connected body of work.</p>
      </div>
      <dl>
        <div><dt>My role</dt><dd>Concept, brand identity, creative direction, generative production, selection, and sequencing</dd></div>
        <div><dt>Tools</dt><dd>Higgsfield, reference-led image and video generation, Next.js portfolio presentation</dd></div>
        <div><dt>Collaboration</dt><dd>Self-directed project developed with generative AI tools</dd></div>
        <div><dt>Output</dt><dd>Campaign film, motion studies, key art, and an interactive case study</dd></div>
      </dl>
    `;
    videoGrid.insertAdjacentElement("beforebegin", section);
  }

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
      "margin:clamp(72px,10vh,128px) 0 clamp(90px,14vh,180px)",
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
    const firstVideo = firstProject.querySelector(".drca-video-card");
    if (firstVideo) {
      firstVideo.insertAdjacentElement("afterend", section);
    } else {
      firstProject.prepend(section);
    }
  }

  function mountPortfolioEnhancements() {
    mountExplanation();
    mountTree();
  }

  const observer = new MutationObserver(mountPortfolioEnhancements);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPortfolioEnhancements, { once: true });
  } else {
    mountPortfolioEnhancements();
  }
  window.addEventListener("load", () => window.setTimeout(mountPortfolioEnhancements, 250), { once: true });
})();
