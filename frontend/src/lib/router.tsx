import { forwardRef, useMemo } from "react";
import type { AnchorHTMLAttributes } from "react";
import { Link as RRLink, useLocation, useNavigate, useSearchParams as useRRSearchParams } from "react-router-dom";

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string };

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link({ href, ...rest }, ref) {
  return <RRLink ref={ref} to={href} {...rest} />;
});

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (to: string) => navigate(to),
      replace: (to: string) => navigate(to, { replace: true }),
      back: () => navigate(-1),
    }),
    [navigate]
  );
}

export function usePathname() {
  return useLocation().pathname;
}

export function useSearchParams() {
  return useRRSearchParams()[0];
}
export { useParams } from "react-router-dom";
export default Link;
