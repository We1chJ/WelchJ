import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: the resume renderer is imperative and must init exactly once.
createRoot(document.getElementById('root')!).render(<App />);
