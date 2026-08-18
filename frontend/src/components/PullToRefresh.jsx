import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import FocusMark from "./FocusMark.jsx";

const THRESHOLD = 52; // px of pull needed to trigger a refresh on release
const MAX_PULL = 64; // px past which further dragging stops adding visual pull (diminishing resistance)

// body already has overscroll-behavior-y: contain (see App.css), so the
// browser's own native pull-to-refresh never fires - this is a from-scratch
// gesture, not a restyle of one. Tracks a touch starting at scrollY 0,
// converts vertical drag distance into a rubber-banded pull, shows the
// brand reticle mark scaling in with the pull, then breathing in place
// (no rotation - a converging reticle spinning doesn't read right) while
// the refresh is in flight, and calls onRefresh() when released past
// THRESHOLD.
export default function PullToRefresh({ onRefresh, children }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startY = useRef(null);
  const pulling = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);

  useEffect(() => {
    function onTouchStart(e) {
      if (window.scrollY > 0 || refreshingRef.current) return;
      startY.current = e.touches[0].clientY;
      pulling.current = true;
      setDragging(true);
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
      // Switch off drag mode now, before the pull value changes below -
      // everything that happens to `pull` from here on (settling at
      // THRESHOLD while refreshing, or springing back to 0) should ease
      // instead of jumping, which is exactly what dragging=false enables
      // on the motion elements further down.
      setDragging(false);
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
  // While an actual finger drag is happening the pull height/offset must
  // track the touch with zero lag (duration: 0) or it feels laggy/rubbery
  // in the wrong way. The moment the finger lifts (dragging false), the
  // same values get a real spring so the collapse back to 0 - or the
  // settle down to THRESHOLD while refreshing - animates instead of
  // snapping instantly.
  const snapTransition = dragging
    ? { duration: 0 }
    : { type: "spring", stiffness: 380, damping: 32 };

  return (
    <>
      <motion.div
        className="fd-ptr"
        animate={{ height: pull, opacity: pull > 4 ? 1 : 0 }}
        transition={snapTransition}
      >
        <motion.div
          className="fd-ptr__icon"
          animate={
            refreshing
              ? { scale: [1, 1.22, 1], opacity: [0.75, 1, 0.75] }
              : { scale: 0.6 + progress * 0.4, opacity: 0.5 + progress * 0.5 }
          }
          transition={
            refreshing
              ? { repeat: Infinity, duration: 1.1, ease: "easeInOut" }
              : { duration: 0 }
          }
        >
          <FocusMark size={22} strokeWidth={2} />
        </motion.div>
      </motion.div>
      <motion.div animate={{ y: pull }} transition={snapTransition}>
        {children}
      </motion.div>
    </>
  );
}
