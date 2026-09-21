import { motion, AnimatePresence } from "framer-motion";

// Stand-in for the browser's native page-load progress bar - which
// can't be restyled (it's browser chrome, not something a site can
// touch), and which doesn't exist at all once the app is running
// installed/standalone anyway. This fills to ~80% quickly then eases
// toward 95% while `active` stays true (we don't know real progress,
// same as most of these indicators), and snaps to 100% + fades out the
// instant the caller flips `active` off.
export default function TopLoadingBar({ active }) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="fd-loadbar"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.25, delay: 0.15 } }}
        >
          <motion.div
            className="fd-loadbar__fill"
            initial={{ width: "0%" }}
            animate={{ width: "92%" }}
            exit={{ width: "100%", transition: { duration: 0.2, ease: "easeOut" } }}
            transition={{ duration: 4, ease: [0.1, 0.6, 0.2, 1] }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
