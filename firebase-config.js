import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyCEgFgyMWkjZlr1UQzGTgarvGdSwKxmYUk",
    authDomain: "projectpushidea.firebaseapp.com",
    databaseURL: "https://projectpushidea-default-rtdb.firebaseio.com",
    projectId: "projectpushidea",
    messagingSenderId: "803856726143",
    appId: "1:803856726143:web:45bdaef46dc2209eb0274a"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const rtdb = getDatabase(app);
export const googleProvider = new GoogleAuthProvider();