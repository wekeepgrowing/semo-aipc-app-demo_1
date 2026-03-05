import { LoaderCircle } from "lucide-react";

export default function ApplyingStep({ title = "온보딩 정보를 불러오는 중", detail = "잠시만 기다려 주세요." }) {
  return (
    <div className="ov0-step ov0-center">
      <LoaderCircle className="ov0-spin" size={30} />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}
