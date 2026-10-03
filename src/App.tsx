import { useRoute } from "./router";
import Home from "./routes/Home";
import Room from "./routes/Room";
import Stage from "./routes/Stage";

export default function App() {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <Home />;
    case "room":
      return <Room roomId={route.roomId} />;
    case "stage":
      return <Stage roomId={route.roomId} />;
    case "notFound":
      return (
        <main className="grid h-full place-items-center font-pixel text-2xl">
          404 — ไม่พบหน้านี้
        </main>
      );
  }
}
