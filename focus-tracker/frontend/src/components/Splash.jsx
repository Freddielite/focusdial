import { useEffect, useState } from "react";
import { motion } from "framer-motion";

const FULL_TEXT = "Focus.";
const TYPE_SPEED_MS = 130;
const HOLD_AFTER_MS = 650;

export default function Splash({ onComplete }) {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let i = 0;
    const typeTimer = setInterval(() => {
      i += 1;
      setTyped(FULL_TEXT.slice(0, i));
      if (i >= FULL_TEXT.length) {
        clearInterval(typeTimer);
        setTimeout(onComplete, HOLD_AFTER_MS);
      }
    }, TYPE_SPEED_MS);
    return () => clearInterval(typeTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <motion.div
      className="fd-splash"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.6, ease: "easeInOut" } }}
    >
      <motion.div
        className="fd-splash__text"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        {typed}
        <span className="fd-splash__cursor" aria-hidden="true" />
      </motion.div>
    </motion.div>
  );
}
