import smallLogo from '../../logos/small logo.png';

type BrandLogoProps = {
  className?: string;
};

export function BrandLogo({ className = '' }: BrandLogoProps) {
  return (
    <img
      src={smallLogo}
      alt="Store Listen. Real Conversations. Real Sales."
      width={1083}
      height={360}
      className={`brand-logo ${className}`.trim()}
    />
  );
}