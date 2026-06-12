import { Link } from "react-router-dom";

// Shared footer for the public (logged-out) pages: landing, download,
// terms, privacy.
export default function PublicFooter() {
  return (
    <footer className="border-t border-gray-800 mt-16 py-8">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-gray-600 text-sm">
          Randall's Nightly Tournaments — free Melee brackets, every night.
        </p>
        <nav className="flex items-center gap-6 text-sm">
          <Link to="/download" className="text-gray-400 hover:text-white">
            Download
          </Link>
          <Link to="/terms" className="text-gray-400 hover:text-white">
            Terms
          </Link>
          <Link to="/privacy" className="text-gray-400 hover:text-white">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
