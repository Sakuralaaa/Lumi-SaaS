import TemplateGallery from '../components/TemplateGallery';

export default function Templates() {
  return (
    <div className="page">
      <div className="page-hd">
        <h2>灵感模板</h2>
        <span>挑一个喜欢的，上传自己的商品做同款</span>
      </div>
      <TemplateGallery />
    </div>
  );
}
