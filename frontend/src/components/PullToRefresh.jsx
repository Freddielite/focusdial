import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

const THRESHOLD = 70; // px of pull needed to trigger a refresh on release
const MAX_PULL = 110; // px past which further dragging stops adding visual pull (diminishing resistance)

// body already has overscroll-behavior-y: contain (see App.css), so the
// browser's own native pull-to-refresh never fires - this is a from-scratch
// gesture, not a restyle of one. Tracks a touch starting at scrollY 0,
// converts vertical drag distance into a rubber-banded pull, shows a
// spinning brass ring past the pull, and calls onRefresh() when released
// past THRESHOLD.
export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(null);
  const pulling = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY > 0 || refreshingRef.current) return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    }

    function onTouchMove(e) {
      if (!pulling.current || startY.current == null) return;
      const delta = e.touches[0].clientY - startY.current;
      if (delta <= 0) {
        pullRef.current = 0;
        setPull(0);
        return;
      }
      // Rubber-band: the further past MAX_PULL you drag, the less it
      // actually moves - matches the "give" native overscroll has instead
      // of tracking the finger 1:1 forever.
      const eased = delta < MAX_PULL ? delta : MAX_PULL + (delta - MAX_PULL) * 0.15;
      pullRef.current = eased;
      setPull(eased);
      // Prevents the page itself from scrolling while a pull is in
      // progress - without this, dragging down at scrollY 0 does nothing
      // visually (nothing to scroll to) so it reads as an inert gesture
      // instead of a smooth pull.
      if (delta > 4) e.preventDefault();
    }

    async function onTouchEnd() {
      if (!pulling.current) return;
      pulling.current = false;
      startY.current = null;
      if (pullRef.current >= THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        pullRef.current = THRESHOLD;
        setPull(THRESHOLD);
        try {
          await onRefresh();
        } finally {
          refreshingRef.current = false;
          setRefreshing(false);
          pullRef.current = 0;
          setPull(0);
        }
      } else {
        pullRef.current = 0;
        setPull(0);
      }
    }

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh]);

  const progress = Math.min(pull / THRESHOLD, 1);

  return (
    <>
      <div className="fd-ptr" style={{ height: pull, opacity: pull > 4 ? 1 : 0 }}>
        <motion.svg
          className="fd-ptr__icon"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          animate={refreshing ? { rotate: 360 } : { rotate: progress * 220 }}
          transition={
            refreshing
              ? { repeat: Infinity, duration: 0.7, ease: "linear" }
              : { duration: 0 }
          }
        >
          <path d="M3 12a9 9 0 1 1 3 6.7" />
          <path d="M3 21v-6h6" />
        </motion.svg>
      </div>
      <div style={{ transform: pull ? `translateY(${pull}px)` : undefined }}>{children}</div>
    </>
  );
}
