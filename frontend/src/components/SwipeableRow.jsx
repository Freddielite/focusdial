import { useEffect, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";

// How far (px) a drag has to travel - or how fast it has to be flung -
// before release counts as a deliberate swipe rather than a nudge that
// should just spring back. Two ways to trigger it (distance OR
// velocity) because a fast flick often doesn't travel far before the
// finger lifts, and a slow deliberate drag doesn't move fast - either
// one alone would miss a real gesture users expect to work.
const SWIPE_THRESHOLD_PX = 88;
const SWIPE_THRESHOLD_VELOCITY = 500;
const MAX_DRAG_PX = 120;

// Wraps a list row (task, session, reminder, whatever) with iOS-Mail-
// style swipe actions: drag right to reveal a positive action
// (complete), drag left for a destructive one (delete). This
// supplements existing tap targets rather than replacing them - the
// checkbox/delete button inside `children` still work exactly as
// before, swipe is just a faster path to the same actions.
//
// `rightAction`/`leftAction` shape: { icon: <ReactNode>, color: "#..." }.
// Omit either one (along with its matching onSwipeRight/onSwipeLeft) to
// disable that direction - e.g. a session-history row has nothing
// sensible to "complete", so it only gets leftAction/onSwipeLeft.
export default function SwipeableRow({ children, onSwipeRight, onSwipeLeft, rightAction, leftAction, disabled = false }) {
  const [dragX, setDragX] = useState(0);
  // A static animate={{x: 0}} target doesn't reliably re-trigger once a
  // drag gesture has taken ownership of the element's position - since
  // the object's *values* never change between renders, nothing tells
  // Framer Motion "go back to 0" again after the first time. That's
  // exactly why cancelling a swipe (not dragging far/fast enough to
  // commit) could leave the row stuck wherever the finger let go instead
  // of springing back. Explicit animation controls sidestep that: every
  // drag end calls controls.start(...) directly, so the reset always
  // actually fires, whether the swipe committed or not.
  const controls = useAnimationControls();

  const canRight = Boolean(onSwipeRight && rightAction);
  const canLeft = Boolean(onSwipeLeft && leftAction);

  // If a row gets disabled mid-drag (e.g. tapping into edit before
  // lifting the finger), make sure it also snaps back rather than
  // staying stuck wherever it was - same reset, just triggered by a
  // prop change instead of a drag ending.
  useEffect(() => {
    if (disabled) {
      controls.start({ x: 0, transition: { type: "spring", stiffness: 500, damping: 40 } });
      setDragX(0);
    }
  }, [disabled, controls]);

  // Nothing to swipe to - skip the wrapper markup and drag machinery
  // entirely rather than rendering an inert one.
  if (!canRight && !canLeft) return children;

  function handleDragEnd(_, info) {
    const { offset, velocity } = info;
    const committed = Math.abs(offset.x) > SWIPE_THRESHOLD_PX || Math.abs(velocity.x) > SWIPE_THRESHOLD_VELOCITY;
    controls.start({ x: 0, transition: { type: "spring", stiffness: 500, damping: 40 } });
    setDragX(0);
    if (committed && offset.x > 0 && canRight) onSwipeRight();
    else if (committed && offset.x < 0 && canLeft) onSwipeLeft();
  }

  const showRight = dragX > 8 && canRight;
  const showLeft = dragX < -8 && canLeft;
  // 0-1: how close the current drag is to the trigger threshold - scales
  // the revealed icon up slightly as you approach it, so there's a
  // physical sense of "a little further and this commits" rather than
  // the icon just sitting there at a fixed size the whole drag.
  const progress = Math.min(Math.abs(dragX) / SWIPE_THRESHOLD_PX, 1);

  return (
    <div className="fd-swipe-row">
      {(showRight || showLeft) && (
        <div
          className="fd-swipe-row__action"
          style={{
            justifyContent: showRight ? "flex-start" : "flex-end",
            background: showRight ? rightAction.color : leftAction.color,
          }}
        >
          <span
            className="fd-swipe-row__action-inner"
            style={{ transform: `scale(${0.7 + progress * 0.3})`, opacity: 0.5 + progress * 0.5 }}
          >
            {showRight ? rightAction.icon : leftAction.icon}
          </span>
        </div>
      )}
      <motion.div
        className="fd-swipe-row__content"
        drag={disabled ? false : "x"}
        dragConstraints={{ left: canLeft ? -MAX_DRAG_PX : 0, right: canRight ? MAX_DRAG_PX : 0 }}
        dragElastic={0.15}
        // Without this, Framer Motion runs its own built-in "spring back
        // within constraints" animation on release, in parallel with the
        // explicit controls.start(...) reset below - two animations
        // fighting over the same element. Barely noticeable for a small
        // cancelled drag, but at the extreme end (where the built-in
        // correction has the most distance to cover and the most
        // momentum behind it) it could win the fight and leave the row
        // stuck wherever that left off. Disabling momentum makes the
        // explicit reset the only thing driving the animation.
        dragMomentum={false}
        onDrag={(_, info) => setDragX(info.offset.x)}
        onDragEnd={handleDragEnd}
        animate={controls}
      >
        {children}
      </motion.div>
    </div>
  );
}
