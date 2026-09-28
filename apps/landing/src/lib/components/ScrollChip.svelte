<script lang="ts">
	const SQUIGGLE =
		'M12 1.50724V0.507237V1.50724ZM30 5.7735L20 0V11.547L30 5.7735ZM0 5.7735V6.7735C0.908537 6.7735 1.45228 6.91659 1.82282 7.08571C2.20197 7.25875 2.46887 7.48658 2.83993 7.81263C3.20174 8.13054 3.6677 8.54667 4.34678 8.8566C5.03445 9.17045 5.87427 9.34934 7 9.34934V8.34934V7.34934C6.09146 7.34934 5.54772 7.20625 5.17718 7.03714C4.79803 6.8641 4.53113 6.63626 4.16007 6.31022C3.79827 5.99231 3.3323 5.57618 2.65322 5.26625C1.96555 4.95239 1.12573 4.7735 0 4.7735V5.7735ZM7 8.34934V9.34934C7.65129 9.34934 8.23379 9.21118 8.73092 8.91264C9.2291 8.61346 9.57104 8.19557 9.80816 7.75032C10.2512 6.91839 10.3819 5.86391 10.4909 5.06318C10.6147 4.15338 10.7169 3.49733 10.9571 3.04637C11.0616 2.85018 11.1739 2.73353 11.2987 2.65853C11.4247 2.58289 11.6342 2.50724 12 2.50724V1.50724V0.507237C11.3487 0.507237 10.7662 0.6454 10.2691 0.943942C9.77091 1.24311 9.42896 1.661 9.19184 2.10626C8.74879 2.93819 8.61815 3.99267 8.50914 4.7934C8.38528 5.7032 8.28305 6.35924 8.04289 6.81021C7.93841 7.0064 7.82615 7.12305 7.70125 7.19805C7.57531 7.27369 7.36585 7.34934 7 7.34934V8.34934ZM12 1.50724V2.50724C12.8325 2.50724 13.1385 2.71836 13.2863 2.87058C13.4894 3.07965 13.6088 3.38274 13.8019 3.95847C13.9666 4.4493 14.2051 5.21278 14.779 5.80364C15.4081 6.45135 16.2983 6.7735 17.5 6.7735V5.7735V4.7735C16.6675 4.7735 16.3615 4.56238 16.2137 4.41016C16.0106 4.20109 15.8912 3.898 15.6981 3.32227C15.5334 2.83143 15.2949 2.06796 14.721 1.4771C14.0919 0.829393 13.2017 0.507237 12 0.507237V1.50724ZM17.5 5.7735V6.7735H21V5.7735V4.7735H17.5V5.7735Z';
</script>

<a
	href="#how"
	class="chip group flex items-center gap-3 rounded-[10px] bg-blush-strong py-2.5 pr-2.5 pl-4 text-[clamp(1.125rem,1.65vw,1.5rem)] whitespace-nowrap text-[#1a0a0d]"
>
	Scroll to learn more
	<span
		class="orb relative grid size-10 shrink-0 place-items-center rounded-full bg-blush text-crimson"
		aria-hidden="true"
	>
		<svg viewBox="0 0 40 40" class="orb-ring absolute inset-0 size-full">
			<circle
				cx="20"
				cy="20"
				r="18.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-dasharray="1.5 4.2"
				stroke-linecap="round"
			/>
		</svg>
		<span class="arrow grid place-items-center">
			<span class="bob grid place-items-center">
				<svg viewBox="0 0 30 11.547" class="h-[10px] w-[26px] rotate-90 fill-current">
					<path d={SQUIGGLE} />
				</svg>
			</span>
		</span>
	</span>
</a>

<style>
	.chip {
		box-shadow: 0 10px 24px -14px rgb(120 0 20 / 0.45);
		transition:
			background-color 0.2s ease,
			transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.chip:hover {
		background: var(--color-rose);
		transform: translateY(-2px);
	}

	.chip:focus-visible {
		outline: 3px solid var(--color-night-900);
		outline-offset: 3px;
	}

	.orb-ring {
		animation: spin 9s linear infinite;
	}

	.arrow {
		transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.chip:hover .arrow {
		transform: translateY(3px);
	}

	@media (prefers-reduced-motion: reduce) {
		.chip,
		.arrow {
			transition: none;
		}

		.orb-ring {
			animation: none;
		}
	}
</style>
