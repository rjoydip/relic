import DefaultTheme from "vitepress/theme";
import { onMounted, onUnmounted } from "vue";

/**
 * The whole manual is one page, so every sidebar link is `/#anchor` on the same
 * route and VitePress's route-based active state can never fire. Track the
 * heading nearest the top instead and reuse VitePress's own `is-active` style.
 */
export default {
  extends: DefaultTheme,
  setup() {
    let frame = 0;

    const update = () => {
      frame = 0;
      const links = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(".VPSidebarItem a[href^='/#']"),
      );
      let active: HTMLAnchorElement | null = null;
      for (const link of links) {
        const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
        if (target && target.getBoundingClientRect().top <= 96) active = link;
      }
      for (const link of links) {
        const current = link === active;
        link.closest(".VPSidebarItem")?.classList.toggle("is-active", current);
        if (current) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    onMounted(() => {
      update();
      window.addEventListener("scroll", onScroll, { passive: true });
    });
    onUnmounted(() => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    });
  },
};
