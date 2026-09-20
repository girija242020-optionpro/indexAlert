# Render setup (ek hi service)

1. GitHub pe naya repo banao, is folder ki saari files repo ke root me upload karo (`.env` kabhi upload mat karna).
2. Render > New + > Web Service > apna repo select karo.
3. Fields:
   - Name: dhan-alert
   - Region: Singapore
   - Branch: main
   - Root Directory: (khali chhodo)
   - Runtime: Node
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Starter (Free plan idle hone par sleep ho jata hai, feed band ho jayegi)
   - Advanced > Health Check Path: /healthz
4. Environment Variables (Add from .env me ek saath paste kar sakte ho):
   NODE_VERSION=22
   DHAN_CLIENT_ID=<apna Dhan client id>
   DHAN_PIN=<apna Dhan PIN>
   DHAN_TOTP_SECRET=<TOTP secret>
   VAPID_PUBLIC_KEY=<chat wali public key>
   VAPID_PRIVATE_KEY=<chat wali private key>
   VAPID_SUBJECT=mailto:<apna email>
   API_KEY=<chat wali access key>
   (TOTP nahi hai to DHAN_PIN/DHAN_TOTP_SECRET ki jagah DHAN_ACCESS_TOKEN daalo, wo roz badalna padega.)
5. Create Web Service dabao. Deploy hone ke baad:
   - https://<naam>.onrender.com/healthz  ->  ok
   - https://<naam>.onrender.com/  ->  app khulega (URL alag se daalna nahi padega)
6. Phone Chrome me kholo > menu > Install app > Settings > "Access key" me API_KEY daalo > Save > "Enable sound, notifications and push".
7. Settings > "Check backend health": dhanAuthenticated true hona chahiye; market hours me marketFeed true.
